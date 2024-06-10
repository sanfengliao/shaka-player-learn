/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { MediaQualityInfo } from '../../externs/shaka';
import { AesKey } from '../../externs/shaka/manifest';
import { asserts } from '../debug/asserts';
import { log } from '../debug/log';
import { ArrayUtils } from '../util/array_utils';
import { BufferUtils } from '../util/buffer_utils';

/**
 * Creates an InitSegmentReference, which provides the location to an
 * initialization segment.
 *
 * @export
 */
export class InitSegmentReference {
  getUris: () => string[];
  startByte: number;
  endByte: number | null;
  mediaQuality: MediaQualityInfo | null;
  timescale: number | null;
  segmentData: BufferSource | null;
  aesKey: AesKey | null;
  codecs: string | null;
  mimeType: string | null;

  /**
   * @param uris A function that creates the URIs
   *   of the resource containing the segment.
   * @param startByte The offset from the start of the resource to the
   *   start of the segment.
   * @param endByte The offset from the start of the resource
   *   to the end of the segment, inclusive.  A value of null indicates that the
   *   segment extends to the end of the resource.
   * @param mediaQuality Information about
   *   the quality of the media associated with this init segment.
   * @param timescale
   * @param segmentData
   * @param aesKey The segment's AES-128-CBC full segment encryption key and iv.
   */
  constructor(
    uris: () => string[],
    startByte: number,
    endByte: number | null,
    mediaQuality: MediaQualityInfo | null = null,
    timescale: number | null = null,
    segmentData: BufferSource | null = null,
    aesKey: AesKey | null = null
  ) {
    this.getUris = uris;

    this.startByte = startByte;

    this.endByte = endByte;

    this.mediaQuality = mediaQuality;

    this.timescale = timescale;

    this.segmentData = segmentData;

    this.aesKey = aesKey;

    this.codecs = null;

    this.mimeType = null;
  }

  /**
   * Returns the offset from the start of the resource to the
   * start of the segment.
   * @export
   */
  getStartByte() {
    return this.startByte;
  }

  /**
   * Returns the offset from the start of the resource to the end of the
   * segment, inclusive.  A value of null indicates that the segment extends
   * to the end of the resource.
   * @export
   */
  getEndByte() {
    return this.endByte;
  }

  /**
   * Returns the size of the init segment.
   */
  getSize() {
    if (this.endByte) {
      return this.endByte - this.startByte;
    } else {
      return null;
    }
  }

  /**
   * Returns media quality information for the segments associated with
   * this init segment.
   */
  getMediaQuality() {
    return this.mediaQuality;
  }

  /**
   * Return the segment data.
   */
  getSegmentData() {
    return this.segmentData;
  }

  /**
   * Check if two initSegmentReference have all the same values.
   * @param reference1
   * @param reference2
   * @return {boolean}
   */
  static equal(reference1: InitSegmentReference | null, reference2: InitSegmentReference) {
    if (reference1 === reference2) {
      return true;
    } else if (!reference1 || !reference2) {
      return reference1 == reference2;
    } else {
      return (
        reference1.getStartByte() == reference2.getStartByte() &&
        reference1.getEndByte() == reference2.getEndByte() &&
        ArrayUtils.equal(reference1.getUris().sort(), reference2.getUris().sort()) &&
        BufferUtils.equal(reference1.getSegmentData(), reference2.getSegmentData())
      );
    }
  }
}

/**
 * SegmentReference provides the start time, end time, and location to a media
 * segment.
 *
 * @export
 */
export class SegmentReference {
  startTime: number;
  endTime: number;
  trueEndTime: number;
  getUrisInner: () => string[];
  startByte: number;
  endByte: number | null;
  initSegmentReference: InitSegmentReference | null;
  timestampOffset: number;
  appendWindowStart: number;
  appendWindowEnd: number;
  partialReferences: SegmentReference[];
  tilesLayout: string;
  tileDuration: number | null;
  syncTime: number | null;
  status: number;
  aesKey: AesKey | null;
  preload: boolean;
  independent: boolean;
  byterangeOptimization: boolean;
  thumbnailSprite: ThumbnailSprite | null;
  discontinuitySequence: number;
  allPartialSegments: boolean;
  partial: boolean;
  lastPartial: boolean;
  segmentData: BufferSource | null;
  codecs: string | null;
  mimeType: string | null;

  /**
   * @param startTime The segment's start time in seconds.
   * @param endTime The segment's end time in seconds.  The segment
   *   ends the instant before this time, so |endTime| must be strictly greater
   *   than |startTime|.
   * @param uris A function that creates the URIs of the resource containing the segment.
   * @param startByte The offset from the start of the resource to the
   *   start of the segment.
   * @param endByte The offset from the start of the resource to the
   *   end of the segment, inclusive.  A value of null indicates that the
   *   segment extends to the end of the resource.
   * @param  initSegmentReference
   *   The segment's initialization segment metadata, or null if the segments
   *   are self-initializing.
   * @param timestampOffset
   *   The amount of time, in seconds, that must be added to the segment's
   *   internal timestamps to align it to the presentation timeline.
   *   <br>
   *   For DASH, this value should equal the Period start time minus the first
   *   presentation timestamp of the first frame/sample in the Period.  For
   *   example, for MP4 based streams, this value should equal Period start
   *   minus the first segment's tfdt box's 'baseMediaDecodeTime' field (after
   *   it has been converted to seconds).
   *   <br>
   *   For HLS, this value should be the start time of the most recent
   *   discontinuity, or 0 if there is no preceding discontinuity. Only used
   *   in segments mode.
   * @param appendWindowStart
   *   The start of the append window for this reference, relative to the
   *   presentation.  Any content from before this time will be removed by
   *   MediaSource.
   * @param appendWindowEnd
   *   The end of the append window for this reference, relative to the
   *   presentation.  Any content from after this time will be removed by
   *   MediaSource.
   * @param partialReferences
   *   A list of SegmentReferences for the partial segments.
   * @param tilesLayout
   *   The value is a grid-item-dimension consisting of two positive decimal
   *   integers in the format: column-x-row ('4x3'). It describes the
   *   arrangement of Images in a Grid. The minimum valid LAYOUT is '1x1'.
   * @param  tileDuration
   *  The explicit duration of an individual tile within the tiles grid.
   *  If not provided, the duration should be automatically calculated based on
   *  the duration of the reference.
   * @param syncTime
   *  A time value, expressed in seconds since 1970, which is used to
   *  synchronize between streams.  Both produced and consumed by the HLS
   *  parser.  Other components should not need this value.
   * @param  status
   *  The segment status is used to indicate that a segment does not exist or is
   *  not available.
   * @param  aesKey
   *  The segment's AES-128-CBC full segment encryption key and iv.
   * @param allPartialSegments
   *  Indicate if the segment has all partial segments
   */
  constructor(
    startTime: number,
    endTime: number,
    uris: () => string[],
    startByte: number,
    endByte: number | null,
    initSegmentReference: InitSegmentReference | null,
    timestampOffset: number,
    appendWindowStart: number,
    appendWindowEnd: number,
    partialReferences: SegmentReference[] = [],
    tilesLayout: string = '',
    tileDuration: number | null = null,
    syncTime: number | null = null,
    status = SegmentReferenceStatus.AVAILABLE,
    aesKey: AesKey | null = null,
    allPartialSegments: boolean = false
  ) {
    // A preload hinted Partial Segment has the same startTime and endTime.
    asserts.assert(startTime <= endTime, 'startTime must be less than or equal to endTime');
    asserts.assert(endByte == null || startByte < endByte, 'startByte must be < endByte');
    this.startTime = startTime;

    this.endTime = endTime;

    /**
     * The "true" end time of the segment, without considering the period end
     * time.  This is necessary for thumbnail segments, where timing requires us
     * to know the original segment duration as described in the manifest.
     */
    this.trueEndTime = endTime;

    this.getUrisInner = uris;

    this.startByte = startByte;

    this.endByte = endByte;

    this.initSegmentReference = initSegmentReference;

    this.timestampOffset = timestampOffset;

    this.appendWindowStart = appendWindowStart;

    this.appendWindowEnd = appendWindowEnd;

    this.partialReferences = partialReferences;

    this.tilesLayout = tilesLayout;

    this.tileDuration = tileDuration;

    /**
     * A time value, expressed in seconds since 1970, which is used to
     * synchronize between streams.  Both produced and consumed by the HLS
     * parser.  Other components should not need this value.
     *
     */
    this.syncTime = syncTime;

    /** @type {shaka.media.SegmentReference.Status} */
    this.status = status;

    /** @type {boolean} */
    this.preload = false;

    /** @type {boolean} */
    this.independent = true;

    /** @type {boolean} */
    this.byterangeOptimization = false;

    /** @type {?shaka.extern.aesKey} */
    this.aesKey = aesKey;

    /** @type {?shaka.media.SegmentReference.ThumbnailSprite} */
    this.thumbnailSprite = null;

    /** @type {number} */
    this.discontinuitySequence = 0;

    /** @type {boolean} */
    this.allPartialSegments = allPartialSegments;

    /** @type {boolean} */
    this.partial = false;

    /** @type {boolean} */
    this.lastPartial = false;

    for (const partial of this.partialReferences) {
      partial.markAsPartial();
    }
    if (this.allPartialSegments && this.partialReferences.length) {
      const lastPartial = this.partialReferences[this.partialReferences.length - 1];
      lastPartial.markAsLastPartial();
    }

    this.codecs = null;

    this.mimeType = null;

    this.segmentData = null;
  }

  /**
   * Creates and returns the URIs of the resource containing the segment.
   *
   * @export
   */
  getUris() {
    return this.getUrisInner();
  }

  /**
   * Returns the segment's start time in seconds.
   * @export
   */
  getStartTime() {
    return this.startTime;
  }

  /**
   * Returns the segment's end time in seconds.
   * @export
   */
  getEndTime() {
    return this.endTime;
  }

  /**
   * Returns the offset from the start of the resource to the
   * start of the segment.

   * @export
   */
  getStartByte() {
    return this.startByte;
  }

  /**
   * Returns the offset from the start of the resource to the end of the
   * segment, inclusive.  A value of null indicates that the segment extends to
   * the end of the resource.
   * @export
   */
  getEndByte() {
    return this.endByte;
  }

  /**
   * Returns the size of the segment.
   */
  getSize() {
    if (this.endByte) {
      return this.endByte - this.startByte;
    } else {
      return null;
    }
  }

  /**
   * Returns true if it contains partial SegmentReferences.
   */
  hasPartialSegments() {
    return this.partialReferences.length > 0;
  }

  /**
   * Returns true if it contains all partial SegmentReferences.
   */
  hasAllPartialSegments() {
    return this.allPartialSegments;
  }

  /**
   * Returns the segment's tiles layout. Only defined in image segments.
   *
   * @export
   */
  getTilesLayout() {
    return this.tilesLayout;
  }

  /**
   * Returns the segment's explicit tile duration.
   * Only defined in image segments.
   * @export
   */
  getTileDuration() {
    return this.tileDuration;
  }

  /**
   * Returns the segment's status.
   *
   * @export
   */
  getStatus() {
    return this.status;
  }

  /**
   * Mark the reference as unavailable.
   *
   * @export
   */
  markAsUnavailable() {
    this.status = SegmentReferenceStatus.UNAVAILABLE;
  }

  /**
   * Mark the reference as preload.
   */
  markAsPreload() {
    this.preload = true;
  }

  /**
   * Returns true if the segment is preloaded.
   * @export
   */
  isPreload() {
    return this.preload;
  }

  /**
   * Mark the reference as non-independent.
   */
  markAsNonIndependent() {
    this.independent = false;
  }

  /**
   * Returns true if the segment is independent.
   * @export
   */
  isIndependent() {
    return this.independent;
  }

  /**
   * Mark the reference as partial.
   */
  markAsPartial() {
    this.partial = true;
  }

  /**
   * Returns true if the segment is partial.

   * @export
   */
  isPartial() {
    return this.partial;
  }

  /**
   * Mark the reference as being the last part of the full segment
   */
  markAsLastPartial() {
    this.lastPartial = true;
  }

  /**
   * Returns true if reference as being the last part of the full segment.
   * @export
   */
  isLastPartial() {
    return this.lastPartial;
  }

  /**
   * Mark the reference as byterange optimization.
   *
   * The "byterange optimization" means that it is playable using MP4 low
   * latency streaming with chunked data.
   *
   * @export
   */
  markAsByterangeOptimization() {
    this.byterangeOptimization = true;
  }

  /**
   * Returns true if the segment has a byterange optimization.
   *
   * @export
   */
  hasByterangeOptimization() {
    return this.byterangeOptimization;
  }

  /**
   * Set the segment's thumbnail sprite.
   *
   */
  setThumbnailSprite(thumbnailSprite: ThumbnailSprite) {
    this.thumbnailSprite = thumbnailSprite;
  }

  /**
   * Returns the segment's thumbnail sprite.
   *
   * @return {?shaka.media.SegmentReference.ThumbnailSprite}
   * @export
   */
  getThumbnailSprite() {
    return this.thumbnailSprite;
  }

  /**
   * Offset the segment reference by a fixed amount.
   *
   * @param {number} offset The amount to add to the segment's start and end
   *   times.
   * @export
   */
  offset(offset: number) {
    this.startTime += offset;
    this.endTime += offset;
    this.trueEndTime += offset;

    for (const partial of this.partialReferences) {
      partial.startTime += offset;
      partial.endTime += offset;
      partial.trueEndTime += offset;
    }
  }

  /**
   * Sync this segment against a particular sync time that will serve as "0" in
   * the presentation timeline.
   *
   * @export
   */
  syncAgainst(lowestSyncTime: number) {
    if (this.syncTime == null) {
      log.alwaysError('Sync attempted without sync time!');
      return;
    }
    const desiredStart = this.syncTime - lowestSyncTime;
    const offset = desiredStart - this.startTime;
    if (Math.abs(offset) >= 0.001) {
      this.offset(offset);
    }
  }

  /**
   * Set the segment data.
   *
   * @export
   */
  setSegmentData(segmentData: BufferSource) {
    this.segmentData = segmentData;
  }

  /**
   * Return the segment data.
   *
   * @export
   */
  getSegmentData() {
    return this.segmentData;
  }

  /**
   * Updates the init segment reference and propagates the update to all partial
   * references.
   * @param initSegmentReference
   */
  updateInitSegmentReference(initSegmentReference: InitSegmentReference | null) {
    this.initSegmentReference = initSegmentReference;
    for (const partialReference of this.partialReferences) {
      partialReference.updateInitSegmentReference(initSegmentReference);
    }
  }
}

export const enum SegmentReferenceStatus {
  AVAILABLE = 0,
  UNAVAILABLE = 1,
  MISSING = 2,
}
/**
 * A convenient typedef for when either type of reference is acceptable.
 *
 */
export type AnySegmentReference = SegmentReference;

export interface ThumbnailSprite {
  // The thumbnail height in px.
  height: number;
  // The thumbnail width in px.
  width: number;
  // The thumbnail left position in px.
  positionX: number;
  // The thumbnail top position in px.
  positionY: number;
}
