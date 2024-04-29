/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CaptionPacket, ICeaParser } from '../../externs/shaka/cea';

/**
 * Dummy CEA parser.
 * @implements {shaka.extern.ICeaParser}
 */
export class DummyCeaParser implements ICeaParser {
  /**
   * @override
   */
  init(_initSegment: BufferSource) {}

  /**
   * @override
   */
  parse(_mediaSegment: BufferSource): CaptionPacket[] {
    return /* captionPackets= */ [];
  }
}
