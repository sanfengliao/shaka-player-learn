/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @namespace shaka.util.ArrayUtils
 * @summary Array utility functions.
 */

export class ArrayUtils {
  /**
   * Returns whether the two values contain the same value.  This correctly
   * handles comparisons involving NaN.
   * @param {T} a
   * @param {T} b
   * @return {boolean}
   * @template T
   */
  static defaultEquals<T>(a: T, b: T) {
    // NaN !== NaN, so we need to special case it.
    if (
      typeof a === 'number' &&
      typeof b === 'number' &&
      isNaN(a) &&
      isNaN(b)
    ) {
      return true;
    }
    return a === b;
  }

  /**
   * Remove given element from array (assumes no duplicates).
   */
  static remove<T>(array: T[], element: T) {
    const index = array.indexOf(element);
    if (index > -1) {
      array.splice(index, 1);
    }
  }

  /**
   * Count the number of items in the list that pass the check function.
   */
  static count<T>(array: T[], check: (element: T) => boolean) {
    let count = 0;

    for (const element of array) {
      count += check(element) ? 1 : 0;
    }

    return count;
  }

  /**
   * Determines if the given arrays contain equal elements in any order.
   *
   */
  static hasSameElements<T>(
    a: T[],
    b: T[],
    compareFn: (a: T, b: T) => boolean
  ) {
    if (!compareFn) {
      compareFn = ArrayUtils.defaultEquals;
    }
    if (a.length != b.length) {
      return false;
    }

    const copy = b.slice();
    for (const item of a) {
      const idx = copy.findIndex((other) => compareFn(item, other));
      if (idx == -1) {
        return false;
      }
      // Since order doesn't matter, just swap the last element with
      // this one and then drop the last element.
      copy[idx] = copy[copy.length - 1];
      copy.pop();
    }

    return copy.length == 0;
  }

  /**
   * Determines if the given arrays contain equal elements in the same order.
   *
   */
  static equal<T>(a: T[], b: T[], compareFn: (a: T, b: T) => boolean) {
    if (!compareFn) {
      compareFn = ArrayUtils.defaultEquals;
    }
    if (a.length != b.length) {
      return false;
    }

    for (let i = 0; i < a.length; i++) {
      if (!compareFn(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
}
