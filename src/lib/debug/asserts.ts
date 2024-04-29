/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @summary An assertion framework which is compiled out for deployment.
 *   NOTE: this is not the closure library version.  This uses the same name so
 *   the closure compiler will be able to use the conditions to assist type
 *   checking.
 */
export const asserts = {
  /**
   * @param {*} val
   * @param {string} message
   */
  assert(val: any, message: string) {},
};

// Install assert functions.
if (__DEV__) {
  if (console.assert && console.assert.bind) {
    // eslint-disable-next-line no-restricted-syntax
    asserts.assert = console.assert.bind(console);
  }
}
