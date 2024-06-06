/*! @license
 * Shaka Player
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { SegmentReference } from '../../lib/media/segment_reference';
import { Stream } from './manifest';

/**
 * @fileoverview Externs for Transmuxer.
 *
 * @externs
 */

/**
 * An interface for transmuxer plugins.
 *
 * @interface
 * @exportDoc
 */
export interface Transmuxer {
  /**
   * Destroy
   */
  destroy(): void;

  /**
   * Check if the mime type and the content type is supported.
   * @param mimeType
   * @param contentType
   * @return {boolean}
   */
  isSupported(mimeType: string, contentType?: string): boolean;

  /**
   * For any stream, convert its codecs to MP4 codecs.
   * @param contentType
   * @param mimeType
   * @return
   */
  convertCodecs(contentType: string, mimeType: string): string;

  /**
   * Returns the original mimetype of the transmuxer.
   * @return
   */
  getOriginalMimeType(): string;

  /**
   * Transmux a input data to MP4.
   */
  transmux(
    data: BufferSource,
    stream: Stream,
    reference: SegmentReference,
    duration: number,
    contentType: string
  ): Promise<Uint8Array>;
}

/**
 * @exportDoc
 */
export type TransmuxerPlugin = () => Transmuxer;
