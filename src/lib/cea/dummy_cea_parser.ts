/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ICeaParser } from '../../externs/shaka/cea';

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
  parse(_mediaSegment: BufferSource) {
    return /* captionPackets= */ [];
  }
}
