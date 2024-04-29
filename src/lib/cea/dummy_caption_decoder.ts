/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ClosedCaption, ICaptionDecoder } from '../../externs/shaka/cea';

export class DummyCaptionDecoder implements ICaptionDecoder {
  /** @override */
  extract(_userDataSeiMessage: Uint8Array, _pts: number) {}

  decode(): ClosedCaption[] {
    return [];
  }

  /** @override */
  clear() {}

  /** @override */
  getStreams(): string[] {
    return [];
  }
}
