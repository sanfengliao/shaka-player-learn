/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @enum {string}
 * @export
 */
export enum CodecSwitchingStrategy {
  // Allow codec switching which will always involve reloading the
  // `MediaSource`.
  RELOAD = 'reload',
  // Allow codec switching; determine if `SourceBuffer.changeType` is available
  // and attempt to use this first, but fall back to reloading `MediaSource` if
  // not available.
  //
  // Note: Some devices that support `SourceBuffer.changeType` can become stuck
  // in a pause state.
  SMOOTH = 'smooth',
}
