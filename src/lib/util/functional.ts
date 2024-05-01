/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @summary A set of functional utility functions.
 */
export class Functional {
  /**
   * Creates a promise chain that calls the given callback for each element in
   * the array in a catch of a promise.
   *
   * e.g.:
   * Promise.reject().catch(callback(array[0])).catch(callback(array[1]));
   *
   * @template ELEM,RESULT
   */
  static createFallbackPromiseChain<T, R>(
    array: T[],
    callback: (ele: T) => Promise<R>
  ) {
    return array.reduce((promise, elem) => {
      return promise.catch(() => callback(elem));
    }, Promise.reject<R>());
  }

  /**
   * Returns the first array concatenated to the second; used to collapse an
   * array of arrays into a single array.
   *
   */
  static collapseArrays<T>(all: T[], part: T[]) {
    return all.concat(part);
  }

  /**
   * A no-op function that ignores its arguments.  This is used to suppress
   * unused variable errors.
   * @param {...*} args
   */
  static ignored(...args: any[]) {}

  /**
   * A no-op function.  Useful in promise chains.
   */
  static noop() {}

  /**
   * Returns if the given value is not null; useful for filtering out null
   * values.
   *
   * @param {T} value
   * @return {boolean}
   * @template T
   */
  static isNotNull<T>(value: T) {
    return value != null;
  }
}
