/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An interface to standardize how objects are destroyed.
 *
 * @interface
 * @exportInterface
 */
export interface IDestroyable {
  /**
   * Request that this object be destroyed, releasing all resources and shutting
   * down all operations. Returns a Promise which is resolved when destruction
   * is complete. This Promise should never be rejected.
   *
   * @exportInterface
   */
  destroy(): Promise<void>;
}
