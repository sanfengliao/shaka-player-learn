/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { asserts } from '../debug/asserts';
import { log } from '../debug/log';
import { BufferUtils } from './buffer_utils';
import { ShakaError } from './error';
import { Lazy } from './lazy';
import { Platform } from './platform';

type TypedArray = Uint8Array | Uint16Array | Uint32Array;
/**
 * @namespace StringUtils
 * @summary A set of string utility functions.
 * @export
 */
export class StringUtils {
  /**
   * Creates a string from the given buffer as UTF-8 encoding.
   *
   * @param {?BufferSource} data
   * @return {string}
   * @export
   */
  static fromUTF8(data: BufferSource) {
    if (!data) {
      return '';
    }

    let uint8 = BufferUtils.toUint8(data);
    // If present, strip off the UTF-8 BOM.
    if (uint8[0] == 0xef && uint8[1] == 0xbb && uint8[2] == 0xbf) {
      uint8 = uint8.subarray(3);
    }

    if (window.TextDecoder && !Platform.isPS4()) {
      // Use the TextDecoder interface to decode the text.  This has the
      // advantage compared to the previously-standard decodeUriComponent that
      // it will continue parsing even if it finds an invalid UTF8 character,
      // rather than stop and throw an error.
      const utf8decoder = new TextDecoder();
      const decoded = utf8decoder.decode(uint8);
      if (decoded.includes('\uFFFD')) {
        log.alwaysError(
          'Decoded string contains an "unknown character' +
            '" codepoint.  That probably means the UTF8 ' +
            'encoding was incorrect!'
        );
      }
      return decoded;
    } else {
      // Homebrewed UTF-8 decoder based on
      // https://en.wikipedia.org/wiki/UTF-8#Encoding
      // Unlike decodeURIComponent, won't throw on bad encoding.
      // In this way, it is similar to TextDecoder.

      let decoded = '';
      for (let i = 0; i < uint8.length; ++i) {
        // By default, the "replacement character" codepoint.
        let codePoint = 0xfffd;

        // Top bit is 0, 1-byte encoding.
        if ((uint8[i] & 0x80) == 0) {
          codePoint = uint8[i];

          // Top 3 bits of byte 0 are 110, top 2 bits of byte 1 are 10,
          // 2-byte encoding.
        } else if (
          uint8.length >= i + 2 &&
          (uint8[i] & 0xe0) == 0xc0 &&
          (uint8[i + 1] & 0xc0) == 0x80
        ) {
          codePoint = ((uint8[i] & 0x1f) << 6) | (uint8[i + 1] & 0x3f);
          i += 1; // Consume one extra byte.

          // Top 4 bits of byte 0 are 1110, top 2 bits of byte 1 and 2 are 10,
          // 3-byte encoding.
        } else if (
          uint8.length >= i + 3 &&
          (uint8[i] & 0xf0) == 0xe0 &&
          (uint8[i + 1] & 0xc0) == 0x80 &&
          (uint8[i + 2] & 0xc0) == 0x80
        ) {
          codePoint =
            ((uint8[i] & 0x0f) << 12) |
            ((uint8[i + 1] & 0x3f) << 6) |
            (uint8[i + 2] & 0x3f);
          i += 2; // Consume two extra bytes.

          // Top 5 bits of byte 0 are 11110, top 2 bits of byte 1, 2 and 3 are 10,
          // 4-byte encoding.
        } else if (
          uint8.length >= i + 4 &&
          (uint8[i] & 0xf1) == 0xf0 &&
          (uint8[i + 1] & 0xc0) == 0x80 &&
          (uint8[i + 2] & 0xc0) == 0x80 &&
          (uint8[i + 3] & 0xc0) == 0x80
        ) {
          codePoint =
            ((uint8[i] & 0x07) << 18) |
            ((uint8[i + 1] & 0x3f) << 12) |
            ((uint8[i + 2] & 0x3f) << 6) |
            (uint8[i + 3] & 0x3f);
          i += 3; // Consume three extra bytes.
        }

        // JavaScript strings are a series of UTF-16 characters.
        if (codePoint <= 0xffff) {
          decoded += String.fromCharCode(codePoint);
        } else {
          // UTF-16 surrogate-pair encoding, based on
          // https://en.wikipedia.org/wiki/UTF-16#Description
          const baseCodePoint = codePoint - 0x10000;
          const highPart = baseCodePoint >> 10;
          const lowPart = baseCodePoint & 0x3ff;
          decoded += String.fromCharCode(0xd800 + highPart);
          decoded += String.fromCharCode(0xdc00 + lowPart);
        }
      }

      return decoded;
    }
  }

  /**
   * Creates a string from the given buffer as UTF-16 encoding.
   *
   * @param {?BufferSource} data
   * @param {boolean} littleEndian
         true to read little endian, false to read big.
   * @param {boolean=} noThrow true to avoid throwing in cases where we may
   *     expect invalid input.  If noThrow is true and the data has an odd
   *     length,it will be truncated.
   * @return {string}
   * @export
   */
  static fromUTF16(
    data?: BufferSource,
    littleEndian?: boolean,
    noThrow?: boolean
  ) {
    if (!data) {
      return '';
    }

    if (!noThrow && data.byteLength % 2 != 0) {
      log.error('Data has an incorrect length, must be even.');
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.TEXT,
        ShakaError.Code.BAD_ENCODING
      );
    }

    // Use a DataView to ensure correct endianness.
    const length = Math.floor(data.byteLength / 2);
    const arr = new Uint16Array(length);
    const dataView = BufferUtils.toDataView(data);
    for (let i = 0; i < length; i++) {
      arr[i] = dataView.getUint16(i * 2, littleEndian);
    }
    return StringUtils.fromCharCode(arr);
  }

  /**
   * Creates a string from the given buffer, auto-detecting the encoding that is
   * being used.  If it cannot detect the encoding, it will throw an exception.
   *
   * @param {?BufferSource} data
   * @return {string}
   * @export
   */
  static fromBytesAutoDetect(data?: BufferSource) {
    if (!data) {
      return '';
    }

    const uint8 = BufferUtils.toUint8(data);
    if (uint8[0] == 0xef && uint8[1] == 0xbb && uint8[2] == 0xbf) {
      return StringUtils.fromUTF8(uint8);
    } else if (uint8[0] == 0xfe && uint8[1] == 0xff) {
      return StringUtils.fromUTF16(
        uint8.subarray(2),
        /* littleEndian= */ false
      );
    } else if (uint8[0] == 0xff && uint8[1] == 0xfe) {
      return StringUtils.fromUTF16(uint8.subarray(2), /* littleEndian= */ true);
    }

    const isAscii = (i: number) => {
      // arr[i] >= ' ' && arr[i] <= '~';
      return uint8.byteLength <= i || (uint8[i] >= 0x20 && uint8[i] <= 0x7e);
    };

    log.debug('Unable to find byte-order-mark, making an educated guess.');
    if (uint8[0] == 0 && uint8[2] == 0) {
      return StringUtils.fromUTF16(data, /* littleEndian= */ false);
    } else if (uint8[1] == 0 && uint8[3] == 0) {
      return StringUtils.fromUTF16(data, /* littleEndian= */ true);
    } else if (isAscii(0) && isAscii(1) && isAscii(2) && isAscii(3)) {
      return StringUtils.fromUTF8(data);
    }

    throw new ShakaError(
      ShakaError.Severity.CRITICAL,
      ShakaError.Category.TEXT,
      ShakaError.Code.UNABLE_TO_DETECT_ENCODING
    );
  }

  /**
   * Creates a ArrayBuffer from the given string, converting to UTF-8 encoding.
   *
   * @param {string} str
   * @return {!ArrayBuffer}
   * @export
   */
  static toUTF8(str: string) {
    if (window.TextEncoder && !Platform.isPS4()) {
      const utf8Encoder = new TextEncoder();
      return BufferUtils.toArrayBuffer(utf8Encoder.encode(str));
    } else {
      // http://stackoverflow.com/a/13691499
      // Converts the given string to a URI encoded string.  If a character
      // falls in the ASCII range, it is not converted; otherwise it will be
      // converted to a series of URI escape sequences according to UTF-8.
      // Example: 'g#€' -> 'g#%E3%82%AC'
      const encoded = encodeURIComponent(str);
      // Convert each escape sequence individually into a character.  Each
      // escape sequence is interpreted as a code-point, so if an escape
      // sequence happens to be part of a multi-byte sequence, each byte will
      // be converted to a single character.
      // Example: 'g#%E3%82%AC' -> '\x67\x35\xe3\x82\xac'
      const utf8 = unescape(encoded);

      const result = new Uint8Array(utf8.length);
      for (let i = 0; i < utf8.length; i++) {
        const item = utf8[i];
        result[i] = item.charCodeAt(0);
      }
      return BufferUtils.toArrayBuffer(result);
    }
  }

  /**
   * Creates a ArrayBuffer from the given string, converting to UTF-16 encoding.
   *
   * @param {string} str
   * @param {boolean} littleEndian
   * @return {!ArrayBuffer}
   * @export
   */
  static toUTF16(str: string, littleEndian?: boolean) {
    const result = new ArrayBuffer(str.length * 2);
    const view = new DataView(result);
    for (let i = 0; i < str.length; ++i) {
      const value = str.charCodeAt(i);
      view.setUint16(/* position= */ i * 2, value, littleEndian);
    }
    return result;
  }

  /**
   * Creates a new string from the given array of char codes.
   *
   * Using String.fromCharCode.apply is risky because you can trigger stack
   * errors on very large arrays.  This breaks up the array into several pieces
   * to avoid this.
   *
   * @param {!TypedArray} array
   * @return {string}
   */
  static fromCharCode(array: TypedArray) {
    return StringUtils.fromCharCodeImpl_.value()!(array);
  }

  /**
   * Resets the fromCharCode method's implementation.
   * For debug use.
   * @export
   */
  static resetFromCharCode() {
    StringUtils.fromCharCodeImpl_.reset();
  }

  /**
   * This method converts the HTML entities &amp;, &lt;, &gt;, &quot;, &#39;,
   * &nbsp;, &lrm; and &rlm; in string to their corresponding characters.
   *
   * @param {!string} input
   * @return {string}
   */
  static htmlUnescape(input: string) {
    // Used to map HTML entities to characters.
    const htmlUnescapes = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&#39;': "'",
      '&apos;': "'",
      '&nbsp;': '\u{a0}',
      '&lrm;': '\u{200e}',
      '&rlm;': '\u{200f}',
    };

    // Used to match HTML entities and HTML characters.
    const reEscapedHtml = /&(?:amp|lt|gt|quot|apos|#(0+)?39|nbsp|lrm|rlm);/g;
    const reHasEscapedHtml = RegExp(reEscapedHtml.source);
    // This check is an optimization, since replace always makes a copy
    if (input && reHasEscapedHtml.test(input)) {
      return input.replace(reEscapedHtml, (entity) => {
        // The only thing that might not match the dictionary above is the
        // single quote, which can be matched by many strings in the regex, but
        // only has a single entry in the dictionary.
        // @ts-ignore
        return htmlUnescapes[entity] || "'";
      });
    }
    return input || '';
  }

  static fromCharCodeImpl_ = new Lazy(() => {
    /** @param {number} size @return {boolean} */
    const supportsChunkSize = (size: number) => {
      try {
        // The compiler will complain about suspicious value if this isn't
        // stored in a variable and used.
        const buffer = new Uint8Array(size);

        // This can't use the spread operator, or it blows up on Xbox One.
        // So we use apply() instead, which is normally not allowed.
        // See issue #2186 for more details.
        // eslint-disable-next-line no-restricted-syntax
        // @ts-ignore
        const foo = String.fromCharCode.apply(null, buffer);
        asserts.assert(foo, 'Should get value');
        return foo.length > 0; // Actually use "foo", so it's not compiled out.
      } catch (error) {
        return false;
      }
    };

    // Different browsers support different chunk sizes; find out the largest
    // this browser supports so we can use larger chunks on supported browsers
    // but still support lower-end devices that require small chunks.
    // 64k is supported on all major desktop browsers.
    for (let size = 64 * 1024; size > 0; size /= 2) {
      if (supportsChunkSize(size)) {
        return (buffer: TypedArray) => {
          let ret = '';
          for (let i = 0; i < buffer.length; i += size) {
            const subArray = buffer.subarray(i, i + size);

            // This can't use the spread operator, or it blows up on Xbox One.
            // So we use apply() instead, which is normally not allowed.
            // See issue #2186 for more details.
            // eslint-disable-next-line no-restricted-syntax
            // @ts-ignore
            ret += String.fromCharCode.apply(null, subArray); // Issue #2186
          }
          return ret;
        };
      }
    }
    asserts.assert(false, 'Unable to create a fromCharCode method');
    return null;
  });
}
