const { randomBytes } = require('crypto');

const BufferHelper = require('./BufferHelper');

const emptyBuffer = Buffer.alloc(0);

class Sender {
  constructor(socket) {
    this._socket = socket;
    this._firstFragment = true;
    this._compress = false;
    this._bufferedBytes = 0;
    this._deflating = false;
    this._queue = [];
  }

  static frame(data, options) {
    const merge = data.length < 1024 || (options.mask && options.readOnly);
    var offset = options.mask ? 6 : 2;
    var payloadLength = data.length;

    if (data.length >= 65536) {
      offset += 8;
      payloadLength = 127;
    } else if (data.length > 125) {
      offset += 2;
      payloadLength = 126;
    }

    const target = Buffer.allocUnsafe(merge ? data.length + offset : offset);

    target[0] = options.fin ? options.opcode | 0x80 : options.opcode;
    if (options.rsv1) target[0] |= 0x40;

    if (payloadLength === 126) target.writeUInt16BE(data.length, 2);
    else if (payloadLength === 127) {
      target.writeUInt32BE(0, 2);
      target.writeUInt32BE(data.length, 6);
    }

    if (!options.mask) {
      target[1] = payloadLength;
      if (merge) {
        data.copy(target, offset);
        return [target];
      }

      return [target, data];
    }

    const mask = randomBytes(4);

    target[1] = payloadLength | 0x80;
    target[offset - 4] = mask[0];
    target[offset - 3] = mask[1];
    target[offset - 2] = mask[2];
    target[offset - 1] = mask[3];

    if (merge) {
      BufferHelper.mask(data, mask, target, offset, data.length);
      return [target];
    }

    BufferHelper.mask(data, mask, data, 0, data.length);
    return [target, data];
  }

  close(code, data, mask, cb) {
    var buf;

    if (code === undefined) buf = emptyBuffer;
    else if (typeof code !== 'number' || !isValidStatusCode(code)) throw new TypeError('First argument must be a valid error code number');
    else if (data === undefined || data === '') {
      buf = Buffer.allocUnsafe(2);
      buf.writeUInt16BE(code, 0);
    } else {
      buf = Buffer.allocUnsafe(2 + Buffer.byteLength(data));
      buf.writeUInt16BE(code, 0);
      buf.write(data, 2);
    }

    if (this._deflating) {
      this.enqueue([this.doClose, buf, mask, cb]);
    } else {
      this.doClose(buf, mask, cb);
    }
  }

  doClose(data, mask, cb) {
    this.sendFrame(Sender.frame(data, {
      fin: true,
      rsv1: false,
      opcode: 0x08,
      mask,
      readOnly: false
    }), cb);
  }

  ping(data, mask, cb) {
    var readOnly = true;

    if (!Buffer.isBuffer(data)) {
      if (data instanceof ArrayBuffer) data = Buffer.from(data);
      else if (ArrayBuffer.isView(data)) data = viewToBuffer(data);
      else {
        data = Buffer.from(data);
        readOnly = false;
      }
    }

    if (this._deflating) this.enqueue([this.doPing, data, mask, readOnly, cb]);
    else this.doPing(data, mask, readOnly, cb);
  }

  doPing(data, mask, readOnly, cb) {
    this.sendFrame(Sender.frame(data, {
      fin: true,
      rsv1: false,
      opcode: 0x09,
      mask,
      readOnly
    }), cb);
  }

  pong(data, mask, cb) {
    var readOnly = true;

    if (!Buffer.isBuffer(data)) {
      if (data instanceof ArrayBuffer) {
        data = Buffer.from(data);
      } else if (ArrayBuffer.isView(data)) {
        data = viewToBuffer(data);
      } else {
        data = Buffer.from(data);
        readOnly = false;
      }
    }

    if (this._deflating) {
      this.enqueue([this.doPong, data, mask, readOnly, cb]);
    } else {
      this.doPong(data, mask, readOnly, cb);
    }
  }

  /**
   * Frames and sends a pong message.
   *
   * @param {*} data The message to send
   * @param {boolean} mask Specifies whether or not to mask `data`
   * @param {boolean} readOnly Specifies whether `data` can be modified
   * @param {Function} cb Callback
   * @private
   */
  doPong(data, mask, readOnly, cb) {
    this.sendFrame(Sender.frame(data, {
      fin: true,
      rsv1: false,
      opcode: 0x0a,
      mask,
      readOnly
    }), cb);
  }

  send(data, options) {
    var opcode = options.binary ? 2 : 1;
    var rsv1 = options.compress;
    var readOnly = true;
    if (!Buffer.isBuffer(data)) {
      if (data instanceof ArrayBuffer) {
        data = Buffer.from(data);
      } else if (ArrayBuffer.isView(data)) {
        data = viewToBuffer(data);
      } else {
        data = Buffer.from(data);
        readOnly = false;
      }
    }


    console.log(data);


    if (this._firstFragment) {
      this._firstFragment = false;
      this._compress = rsv1;
    } else {
      rsv1 = false;
      opcode = 0;
    }

    if (options.fin) this._firstFragment = true;
    this.sendFrame(Sender.frame(data, {
      fin: options.fin,
      rsv1: false,
      opcode,
      mask: options.mask,
      readOnly
    }));
  }

  /**
   * Dispatches a data message.
   *
   * @param {Buffer} data The message to send
   * @param {boolean} compress Specifies whether or not to compress `data`
   * @param {Object} options Options object
   * @param {number} options.opcode The opcode
   * @param {boolean} options.readOnly Specifies whether `data` can be modified
   * @param {boolean} options.fin Specifies whether or not to set the FIN bit
   * @param {boolean} options.mask Specifies whether or not to mask `data`
   * @param {boolean} options.rsv1 Specifies whether or not to set the RSV1 bit
   * @param {Function} cb Callback
   * @private
   */

  /**
   * Executes queued send operations.
   *
   * @private
   */
  dequeue() {
    while (!this._deflating && this._queue.length) {
      const params = this._queue.shift();

      this._bufferedBytes -= params[1].length;
      params[0].apply(this, params.slice(1));
    }
  }

  /**
   * Enqueues a send operation.
   *
   * @param {Array} params Send operation parameters.
   * @private
   */
  enqueue(params) {
    this._bufferedBytes += params[1].length;
    this._queue.push(params);
  }

  /**
   * Sends a frame.
   *
   * @param {Buffer[]} list The frame to send
   * @param {Function} cb Callback
   * @private
   */
  sendFrame(list, cb) {
    console.log(list);
    if (list.length === 2) {
      this._socket.write(list[0]);
      this._socket.write(list[1], cb);
    } else {
      this._socket.write(list[0]);
    }
  }
}

module.exports = Sender;

/**
 * Converts an `ArrayBuffer` view into a buffer.
 *
 * @param {(DataView|TypedArray)} view The view to convert
 * @returns {Buffer} Converted view
 * @private
 */
function viewToBuffer(view) {
  const buf = Buffer.from(view.buffer);

  if (view.byteLength !== view.buffer.byteLength) {
    return buf.slice(view.byteOffset, view.byteOffset + view.byteLength);
  }

  return buf;
}
