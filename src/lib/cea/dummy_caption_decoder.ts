/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ICaptionDecoder } from '../../externs/shaka/cea';

export class DummyCaptionDecoder implements ICaptionDecoder {
  /** @override */
  extract(_userDataSeiMessage: Uint8Array, _pts: number) {}

  /** @override */
  decode() {
    return [];
  }

  /** @override */
  clear() {}

  /** @override */
  getStreams() {
    return [];
  }
}
