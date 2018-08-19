const EventEmitter = require('./EventEmitter');
const { randomBytes, createHash } = require('crypto');
const { get: requestGateway } = require('https');
const { connect: secureConnect } = require('tls');

const constants = require('./constants');
const Receiver = require('./Receiver');
const Sender = require('./Sender');

const WebSocketSymbol = Symbol('status-code');

class WebSocket extends EventEmitter {
  constructor(options = { endcoding: 'json' }) {
    super();

    this.state = 'OFFLINE';
    this.options = options;
    this._binaryType = ['nodebuffer', 'arraybuffer', 'fragments'];
    this._closeCode = 1006;

    this.connect();
  }

  connect() {
    this.state = 'CONNECTING';

    const key = randomBytes(16).toString('base64');
    const options = Object.assign({
      protocolVersion: 8,
      maxPayload: 100 * 1024 * 1024
    }, this.options);

    options.createConnection = () => secureConnect(Object.assign(options, { path: undefined, servername: options.host }));
    options.port = 443;
    options.host = 'gateway.discord.gg';
    options.path = `/?v=${options.version}&encoding=${options.encoding}`;
    options.headers = {
      'Sec-WebSocket-Version': 13,
      'Sec-WebSocket-Key': key,
      Connection: 'Upgrade',
      Upgrade: 'websocket'
    };

    var gateway = this.gateway = requestGateway(options);
    if (options.handshakeTimeout) gateway.setTimeout(options.handshakeTimeout, () => this.abortHandshake('Opening handshake has timed out'));

    gateway.on('error', error => {
      if (this.gateway.aborted) return;

      gateway = this.gateway = null;
      this.state = 'CLOSED';
      this.emit('error', error);
      this.emitClose();
    });

    gateway.on('response', ({ statusCode }) => this.abortHandshake(`Unexpected server response: ${statusCode}`));

    gateway.on('upgrade', (response, socket, head) => {
      if (this.state !== 'CONNECTING') return;
      gateway = this.gateway = null;

      const digest = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, 'binary').digest('base64');

      if (response.headers['sec-websocket-accept'] !== digest) return this.abortHandshake('Invalid Sec-WebSocket-Accept header');
      const serverProtal = response.headers['sec-websocket-protocol'];
      if (serverProtal) this.protocol = serverProtal;

      const maxPayload = options.maxPayload;
      const receiver = new Receiver(
        this._binaryType,
        {},
        maxPayload
      );

      this._sender = new Sender(socket, {});
      this._receiver = receiver;
      this._socket = socket;

      receiver[WebSocketSymbol] = this;
      socket[WebSocketSymbol] = this;

      receiver.on('conclude', receiverOnConclude);
      receiver.on('drain', receiverOnDrain);
      receiver.on('error', receiverOnError);
      receiver.on('message', receiverOnMessage);
      receiver.on('ping', receiverOnPing);
      receiver.on('pong', receiverOnPong);

      socket.setTimeout(0);
      socket.setNoDelay();

      if (head.length > 0) socket.unshift(head);

      socket.on('close', socketOnClose);
      socket.on('data', socketOnData);
      socket.on('end', socketOnEnd);
      socket.on('error', socketOnError);

      this.state = 'OPEN';
      this.emit('open');
    });
  }

  abortHandshake(reason) {
    this.state = 'CLOSING';

    const error = new Error(reason);
    Error.captureStackTrace(error, this.abortHandshake);

    if (this.gateway.setHeader) {
      this.gateway.abort();
      this.gateway.once('abort', this.emitClose);
      this.emit('error', error);
    } else {
      this.gateway.destroy(error);
      this.gateway.once('error', this.emit.bind('error'));
      this.gatewayonce('close', this.emitClose);
    }
  }

  emitClose() {
    this.state = 'OFFLINE';

    if (!this._socket) {
      this.emit('close', this._closeCode, this._closeMessage);
      return;
    }

    this._receiver.removeAllListeners();
    this.emit('close', { code: this._closeCode, message: this._closeMessage });
  }

  close(code, data) {
    console.log(code);
    if (this.readyState === WebSocket.CLOSED) return;
    if (this.readyState === WebSocket.CONNECTING) {
      const msg = 'WebSocket was closed before the connection was established';
      return this.abortHandshake(this, this.gateway, msg);
    }

    if (this.readyState === WebSocket.CLOSING) {
      if (this._closeFrameSent && this._closeFrameReceived) this._socket.end();
      return;
    }

    this.readyState = WebSocket.CLOSING;
    this._sender.close(code, data, !this._isServer, err => {
      if (err) return;

      this._closeFrameSent = true;

      if (this._socket.writable) {
        if (this._closeFrameReceived) this._socket.end();
        this._closeTimer = setTimeout(
          this._socket.destroy.bind(this._socket),
          this.options.closeTimeout || 30 * 1000
        );
      }
    });
  }

  send(data, options = {}) {
    if (this.state !== 'OPEN') throw new Error(`WebSocket is not open. Current state ${this.state}`);
    this._sender.send(options.stringify ? JSON.stringify(data) : data, { binary: false,
      mask: true,
      compress: false,
      fin: true });
  }

  terminate() {
    if (this.state === 'CLOSED') return true;
    if (this.readyState === 'CONNECTING') return this.abortHandshake('WebSocket was closed before the connection was established');
    if (this._socket) {
      this.state = 'CLOSED';
      this._socket.destroy();
    }
  }
}

function receiverOnConclude(code, reason) {
  const websocket = this[WebSocketSymbol];

  websocket._socket.removeListener('data', socketOnData);
  websocket._socket.resume();

  websocket._closeFrameReceived = true;
  websocket._closeMessage = reason;
  websocket._closeCode = code;

  if (code === 1005) websocket.close();
  else websocket.close(code, reason);
}

function receiverOnDrain() {
  this[WebSocketSymbol]._socket.resume();
}

function receiverOnError(err) {
  const websocket = this[WebSocketSymbol];

  websocket._socket.removeListener('data', socketOnData);

  websocket.readyState = WebSocket.CLOSING;
  websocket._closeCode = err[constants.kStatusCode];
  websocket.emit('error', err);
  websocket._socket.destroy();
}

function receiverOnFinish() {
  this[WebSocketSymbol].emitClose();
}

function receiverOnMessage(data) {
  this[WebSocketSymbol].emit('message', data);
}

function receiverOnPing(data) {
  const websocket = this[WebSocketSymbol];

  websocket.pong(data, !websocket._isServer, constants.NOOP);
  websocket.emit('ping', data);
}

/**
 * The listener of the `Receiver` `'pong'` event.
 *
 * @param {Buffer} data The data included in the pong frame
 * @private
 */
function receiverOnPong(data) {
  this[WebSocketSymbol].emit('pong', data);
}

/**
 * The listener of the `net.Socket` `'close'` event.
 *
 * @private
 */
function socketOnClose() {
  const websocket = this[WebSocketSymbol];

  this.removeListener('close', socketOnClose);
  this.removeListener('end', socketOnEnd);

  websocket.readyState = WebSocket.CLOSING;

  //
  // The close frame might not have been received or the `'end'` event emitted,
  // for example, if the socket was destroyed due to an error. Ensure that the
  // `receiver` stream is closed after writing any remaining buffered data to
  // it. If the readable side of the socket is in flowing mode then there is no
  // buffered data as everything has been already written and `readable.read()`
  // will return `null`. If instead, the socket is paused, any possible buffered
  // data will be read as a single chunk and emitted synchronously in a single
  // `'data'` event.
  //
  websocket._socket.read();
  websocket._receiver.end();

  this.removeListener('data', socketOnData);
  this[WebSocketSymbol] = undefined;

  clearTimeout(websocket._closeTimer);

  if (
    websocket._receiver._writableState.finished ||
    websocket._receiver._writableState.errorEmitted
  ) {
    websocket.emitClose();
  } else {
    websocket._receiver.on('error', receiverOnFinish);
    websocket._receiver.on('finish', receiverOnFinish);
  }
}

/**
 * The listener of the `net.Socket` `'data'` event.
 *
 * @param {Buffer} chunk A chunk of data
 * @private
 */
function socketOnData(chunk) {
  if (!this[WebSocketSymbol]._receiver.write(chunk)) {
    this.pause();
  }
}

/**
 * The listener of the `net.Socket` `'end'` event.
 *
 * @private
 */
function socketOnEnd() {
  const websocket = this[WebSocketSymbol];

  websocket.readyState = WebSocket.CLOSING;
  websocket._receiver.end();
  this.end();
}

/**
 * The listener of the `net.Socket` `'error'` event.
 *
 * @private
 */
function socketOnError() {
  const websocket = this[WebSocketSymbol];

  this.removeListener('error', socketOnError);
  this.on('error', constants.NOOP);

  if (websocket) {
    websocket.readyState = WebSocket.CLOSING;
    this.destroy();
  }
}

module.exports = WebSocket;
