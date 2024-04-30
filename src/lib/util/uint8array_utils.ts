/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { BufferUtils } from './buffer_utils';
import { StringUtils } from './string_utils';

// TODO: revisit this when Closure Compiler supports partially-exported classes.
/**
 * @summary A set of Uint8Array utility functions.
 * @export
 */
export class Uint8ArrayUtils {
  /**
   * Convert a buffer to a base64 string. The output will be standard
   * alphabet as opposed to base64url safe alphabet.
   * @param {BufferSource} data
   * @return {string}
   * @export
   */
  static toStandardBase64(data: BufferSource) {
    const bytes = StringUtils.fromCharCode(BufferUtils.toUint8(data));
    return btoa(bytes);
  }

  /**
   * Convert a buffer to a base64 string.  The output will always use the
   * alternate encoding/alphabet also known as "base64url".
   * @param {BufferSource} data
   * @param {boolean=} padding If true, pad the output with equals signs.
   *   Defaults to true.
   * @return {string}
   * @export
   */
  static toBase64(data: BufferSource, padding = true) {
    const base64 = Uint8ArrayUtils.toStandardBase64(data)
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    return padding ? base64 : base64.replace(/[=]*$/, '');
  }

  /**
   * Convert a base64 string to a Uint8Array.  Accepts either the standard
   * alphabet or the alternate "base64url" alphabet.
   * @param {string} str
   * @return {!Uint8Array}
   * @export
   */
  static fromBase64(str: string) {
    // atob creates a "raw string" where each character is interpreted as a
    // byte.
    const bytes = window.atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    const result = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; ++i) {
      result[i] = bytes.charCodeAt(i);
    }
    return result;
  }

  /**
   * Convert a hex string to a Uint8Array.
   * @param {string} str
   * @return {!Uint8Array}
   * @export
   */
  static fromHex(str: string) {
    const size = str.length / 2;
    const arr = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      arr[i] = window.parseInt(str.substr(i * 2, 2), 16);
    }
    return arr;
  }

  /**
   * Convert a buffer to a hex string.
   * @param {BufferSource} data
   * @return {string}
   * @export
   */
  static toHex(data: BufferSource) {
    const arr = BufferUtils.toUint8(data);
    let hex = '';
    for (let value of arr) {
      let valueStr = value.toString(16);
      if (valueStr.length == 1) {
        valueStr = '0' + value;
      }
      hex += valueStr;
    }
    return hex;
  }

  /**
   * Concatenate buffers.
   * @param {...BufferSource} varArgs
   * @return {!Uint8Array}
   * @export
   */
  static concat(...varArgs: BufferSource[]) {
    let totalLength = 0;
    for (let i = 0; i < varArgs.length; ++i) {
      const value = varArgs[i];
      totalLength += value.byteLength;
    }

    const result = new Uint8Array(totalLength);
    let offset = 0;

    for (let i = 0; i < varArgs.length; ++i) {
      const value = varArgs[i];
      if (value instanceof Uint8Array) {
        result.set(value, offset);
      } else {
        result.set(BufferUtils.toUint8(value), offset);
      }
      offset += value.byteLength;
    }

    return result;
  }
}
