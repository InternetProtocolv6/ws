var bufferUtil = require('bufferutil');
bufferUtil = bufferUtil.BufferUtil || bufferUtil;

class BufferHelper {
  static concat(list, totalLength) {
    const target = Buffer.allocUnsafe(totalLength);
    let offset = 0;

    for (let index = 0; index < list.length; index++) {
      const buffer = list[index];
      buffer.copy(target, offset);
      offset += buffer.length;
    }

    return target;
  }

  static mask(source, mask, output, offset, length) {
    if (length < 48) {
      for (let index = 0; index < length; index++) {
        output[offset + index] = source[index] ^ mask[index & 3];
      }

      return output;
    } else return bufferUtil.mask(source, mask, output, offset, length);
  }

  static unmask(buffer, mask) {
    const length = buffer.length;
    if (length < 32) {
      for (let index = 0; index < length; index++) {
        buffer[index] ^= mask[index & 3];
      }

      return buffer;
    } else return bufferUtil.unmask(buffer, mask);
  }
}

module.exports = BufferHelper;
