/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export class ObjectUtils {
  /**
   * Performs a deep clone of the given simple object.  This does not copy
   * prototypes, custom properties (e.g. read-only), or multiple references to
   * the same object.  If the caller needs these fields, it will need to set
   * them after this returns.
   *
   * @template T
   * @param {T} arg
   * @return {T}
   */
  static cloneObject<T>(arg: T): T {
    const seenObjects = new WeakSet();
    // This recursively clones the value |val|, using the captured variable
    // |seenObjects| to track the objects we have already cloned.
    /** @suppress {strictMissingProperties} */
    const clone = (val: any) => {
      switch (typeof val) {
        case 'undefined':
        case 'boolean':
        case 'number':
        case 'string':
        case 'symbol':
        case 'function':
          return val;
        case 'object':
        default: {
          // typeof null === 'object'
          if (!val) {
            return val;
          }

          // This covers Uint8Array and friends, even without a TypedArray
          // base-class constructor.
          const isTypedArray =
            val.buffer && val.buffer.constructor == ArrayBuffer;
          if (isTypedArray) {
            return val;
          }

          if (seenObjects.has(val)) {
            return null;
          }

          const isArray = val.constructor == Array;
          if (val.constructor != Object && !isArray) {
            return null;
          }

          seenObjects.add(val);
          const ret = isArray ? [] : {};
          // Note |name| will equal a number for arrays.
          for (const name in val) {
            // @ts-ignore
            ret[name] = clone(val[name]);
          }

          // Length is a non-enumerable property, but we should copy it over in
          // case it is not the default.
          if (isArray) {
            // @ts-ignore
            ret.length = val.length;
          }
          return ret;
        }
      }
    };
    return clone(arg);
  }

  /**
   * Performs a shallow clone of the given simple object.  This does not copy
   * prototypes or custom properties (e.g. read-only).
   *
   * @template T
   * @param {T} original
   * @return {T}
   */
  static shallowCloneObject<T extends Object>(original: T): T {
    const clone: T = /** @type {?} */ {} as T;
    for (const k in original) {
      // @ts-ignore
      clone[k] = original[k];
    }
    return clone;
  }
}
