import { ISegmentIndex } from '../../externs/shaka/manifest';
import { asserts } from '../debug/asserts';
import { log } from '../debug/log';

import { IReleasable } from '../util/i_releasable';
import { Timer } from '../util/timer';
import { SegmentReference } from './segment_reference';

export class SegmentIndex implements IReleasable, ISegmentIndex, Iterable<SegmentReference | null> {
  protected references: SegmentReference[];

  /**
   * The number of references that have been removed from the front of the
   * array.  Used to create stable positions in the find/get APIs.
   *
   */
  protected numEvicted_: number;
  /**
   * @param references The list of
   *   SegmentReferences, which must be sorted first by their start times
   *   (ascending) and second by their end times (ascending).
   */

  private timer_: Timer | null;

  private immutable_ = false;

  constructor(references: SegmentReference[]) {
    this.references = references;

    this.timer_ = null;

    this.numEvicted_ = 0;
  }

  getIsImmutable() {
    return this.immutable_;
  }

  getNumReferences(): number {
    return this.references.length;
  }

  getNumEvicted(): number {
    return this.numEvicted_;
  }

  release(): void {
    if (this.immutable_) {
      return;
    }

    this.references = [];

    if (this.timer_) {
      this.timer_.stop();
    }

    this.timer_ = null;
  }

  /**
   * Marks the index as immutable.  Segments cannot be added or removed after
   * this point.  This doesn't affect the references themselves.  This also
   * makes the destroy/release methods do nothing.
   *
   * This is mainly for testing.
   *
   * @export
   */
  markImmutable() {
    this.immutable_ = true;
  }

  /**
   * Iterates over all top-level segment references in this segment index.
   * @param {function(!shaka.media.SegmentReference)} fn
   */
  forEachTopLevelReference(fn: (reference: SegmentReference) => void) {
    for (const reference of this.references) {
      fn(reference);
    }
  }

  /**
   * Return the earliest reference, or null if empty.
   * @return {shaka.media.SegmentReference}
   */
  earliestReference() {
    return this.references[0] || null;
  }

  /**
   * Drop the first N references.
   * Used in early HLS synchronization, and does not count as eviction.
   * @param {number} n
   */
  dropFirstReferences(n: number) {
    this.references.splice(0, n);
  }

  find(time: number): number | null {
    // For live streams, searching from the end is faster.  For VOD, it balances
    // out either way.  In both cases, references.length is small enough that
    // the difference isn't huge.
    const lastReferenceIndex = this.references.length - 1;
    for (let i = lastReferenceIndex; i >= 0; --i) {
      const r = this.references[i];
      const startTime = r.startTime;
      const endTime = i === lastReferenceIndex ? r.endTime : this.references[i + 1].startTime;

      if (time >= startTime && time < endTime) {
        return i + this.numEvicted_;
      }
    }

    if (this.references.length && time < this.references[0].startTime) {
      return this.numEvicted_;
    }
    return null;
  }

  get(position: number): SegmentReference | null {
    if (this.references.length === 0) {
      return null;
    }

    const index = position - this.numEvicted_;

    if (index < 0 || index >= this.references.length) {
      return null;
    }

    return this.references[index];
  }

  /**
   * Offset all segment references by a fixed amount.
   *
   * @param The amount to add to each segment's start and end
   *   times.
   * @export
   */
  offset(offset: number) {
    if (!this.immutable_) {
      for (const ref of this.references) {
        ref.offset(offset);
      }
    }
  }

  /**
   * Merges the given SegmentReferences.  Supports extending the original
   * references only.  Will replace old references with equivalent new ones, and
   * keep any unique old ones.
   *
   * Used, for example, by the DASH and HLS parser, where manifests may not list
   * all available references, so we must keep available references in memory to
   * fill the availability window.
   *
   * @param references The list of
   *   SegmentReferences, which must be sorted first by their start times
   *   (ascending) and second by their end times (ascending).
   */
  merge(references: SegmentReference[]) {
    if (this.immutable_) {
      return;
    }

    if (!references.length) {
      return;
    }

    const firstStartTime = Math.round(references[0].startTime * 1000) / 1000;

    this.references = this.references.filter((r) => {
      return Math.round(r.startTime * 1000) / 1000 < firstStartTime;
    });

    this.references.push(...references);
  }

  /**
   * Merges the given SegmentReferences and evicts the ones that end before the
   * given time.  Supports extending the original references only.
   * Will not replace old references or interleave new ones.
   * Used, for example, by the DASH and HLS parser, where manifests may not list
   * all available references, so we must keep available references in memory to
   * fill the availability window.
   *
   * @param  references The list of
   *   SegmentReferences, which must be sorted first by their start times
   *   (ascending) and second by their end times (ascending).
   * @param windowStart The start of the availability window to filter
   *   out the references that are no longer available.
   * @export
   */
  mergeAndEvict(references: SegmentReference[], windowStart: number) {
    references = references.filter((r) => {
      return r.endTime > windowStart && (this.references.length === 0 || r.endTime > this.references[0].startTime);
    });

    this.merge(references);

    this.evict(windowStart);
  }

  /**
   * Removes all SegmentReferences that end before the given time.
   *
   * @param {number} time The time in seconds.
   * @export
   */
  evict(time: number) {
    if (this.immutable_) {
      return;
    }

    const oldSize = this.references.length;

    this.references = this.references.filter((r) => r.endTime > time);

    const newSize = this.references.length;
    const diff = newSize - oldSize;

    // Tracking the number of evicted refs will keep their "positions" stable
    // for the caller.
    this.numEvicted_ += diff;
  }

  /**
   * Drops references that start after windowEnd, or end before windowStart,
   * and contracts the last reference so that it ends at windowEnd.
   *
   * Do not call on the last period of a live presentation (unknown duration).
   * It is okay to call on the other periods of a live presentation, where the
   * duration is known and another period has been added.
   *
   * @param  windowStart
   * @param  windowEnd
   * @param  isNew Whether this is a new SegmentIndex and we shouldn't
   *   update the number of evicted elements.
   * @export
   */
  fit(windowStart: number, windowEnd: number, isNew = false) {
    if (this.immutable_) {
      return;
    }

    while (this.references.length) {
      const lastReference = this.references[this.references.length - 1];
      if (lastReference.startTime >= windowEnd) {
        this.references.pop();
      } else {
        break;
      }
    }

    while (this.references.length) {
      const firstReference = this.references[0];
      if (firstReference.endTime <= windowStart) {
        this.references.shift();
        if (!isNew) {
          this.numEvicted_++;
        }
      } else {
        break;
      }
    }
    if (this.references.length == 0) {
      return;
    }
    // Adjust the last SegmentReference.
    const lastReference = this.references[this.references.length - 1];

    const newReference = new SegmentReference(
      lastReference.startTime,
      /* endTime= */ windowEnd,
      lastReference.getUrisInner,
      lastReference.startByte,
      lastReference.endByte,
      lastReference.initSegmentReference,
      lastReference.timestampOffset,
      lastReference.appendWindowStart,
      lastReference.appendWindowEnd,
      lastReference.partialReferences,
      lastReference.tilesLayout,
      lastReference.tileDuration,
      lastReference.syncTime,
      lastReference.status,
      lastReference.aesKey
    );

    newReference.mimeType = lastReference.mimeType;
    newReference.codecs = lastReference.codecs;
    newReference.discontinuitySequence = lastReference.discontinuitySequence;

    this.references[this.references.length - 1] = newReference;
  }

  /**
   * Updates the references every so often.  Stops when the references list
   * returned by the callback is null.
   *
   * @param interval The interval in seconds.
   * @param  updateCallback
   * @export
   */

  updateEvery(interval: number, updateCallback: () => SegmentReference[] | null) {
    if (this.immutable_) {
      return;
    }

    if (this.timer_) {
      this.timer_.stop();
    }

    this.timer_ = new Timer(() => {
      const references = updateCallback();
      if (references) {
        this.references.push(...references);
      } else {
        this.timer_?.stop();
        this.timer_ = null;
      }
    });

    this.timer_.tickEvery(interval);
  }

  [Symbol.iterator]() {
    const iter = this.getIteratorForTime(0);
    return iter as Iterator<SegmentReference | null>;
  }

  /**
   * Returns a new iterator that initially points to the segment that contains
   * the given time, or the nearest independent segment before it.
   *
   * Like the normal iterator, next() must be called first to get to the first
   * element. Returns null if we do not find a segment at the
   * requested time.
   *
   * The first segment returned by the iterator _MUST_ be an independent
   * segment.  Assumes that only partial references can be dependent, based on
   * RFC 8216 rev 13, section 8.1: "Each (non-Partial) Media Segment in a Media
   * Playlist will contain at least one independent frame."
   *
   * @param {number} time
   * @param {boolean=} allowNonIndepedent
   * @param {boolean=} reverse
   * @return
   * @export
   */
  getIteratorForTime(time: number, allowNonIndepedent = false, reverse = false) {
    let index = this.find(time);
    if (index === null) {
      return null;
    } else {
      index--;
    }

    // +1 so we can get the element we'll eventually point to so we can see if
    // we need to use a partial segment index.
    const ref = this.get(index + 1);
    let partialSegmentIndex = -1;

    if (ref && ref.hasPartialSegments()) {
      // Look for a partial SegmentReference.
      for (let i = ref.partialReferences.length - 1; i >= 0; --i) {
        let r = ref.partialReferences[i];
        if (time >= r.startTime && time < r.endTime) {
          if (!allowNonIndepedent) {
            while (i && !r.isIndependent()) {
              i--;
              r = ref.partialReferences[i];
            }
            if (!r.isIndependent()) {
              log.alwaysError('No independent partial segment found!');
              return null;
            }
          }
          // Call to next() should move the partial segment, not the full
          // segment.
          index++;
          partialSegmentIndex = i - 1;
          break;
        }
      }
    }
    return new SegmentIterator(this, index, partialSegmentIndex, reverse);
  }

  /**
   * @return {boolean}
   */
  isEmpty() {
    return this.getNumReferences() == 0;
  }

  /**
   * Create a SegmentIndex for a single segment of the given start time and
   * duration at the given URIs.
   *
   * @param startTime
   * @param duration
   * @param uris
   * @return
   * @export
   */

  static forSingleSegment(startTime: number, duration: number, uris: string[]) {
    const reference = new SegmentReference(
      startTime,
      startTime + duration,
      () => uris,
      0,
      null,
      null,
      startTime,
      startTime,
      startTime + duration
    );
    return new SegmentIndex([reference]);
  }
}

class SegmentIterator implements Iterator<SegmentReference | null> {
  private currentPartialPosition_: number;
  private currentPosition_: number;
  private segmentIndex_: SegmentIndex;
  private reverse: boolean;

  constructor(segmentIndex: SegmentIndex, index: number, partialSegmentIndex: number, reverse: boolean) {
    this.segmentIndex_ = segmentIndex;

    this.currentPosition_ = index;

    this.currentPartialPosition_ = partialSegmentIndex;

    this.reverse = reverse;
  }

  /**
   * @param {boolean} reverse
   * @export
   */
  setReverse(reverse: boolean) {
    this.reverse = reverse;
  }

  /**
   * @return {number}
   * @export
   */
  currentPosition() {
    return this.currentPosition_;
  }

  current() {
    let ref = this.segmentIndex_.get(this.currentPosition_);

    // When we advance past the end of partial references in next(), then add
    // new references in merge(), the pointers may not make sense any more.
    // This adjusts the invalid pointer values to point to the next newly added
    // segment or partial segment.
    if (
      ref &&
      ref.hasAllPartialSegments() &&
      ref.hasPartialSegments() &&
      this.currentPartialPosition_ >= ref.partialReferences.length
    ) {
      this.currentPosition_ += 1;
      this.currentPartialPosition_ = 0;
      ref = this.segmentIndex_.get(this.currentPosition_);
    }

    if (ref && ref.hasPartialSegments()) {
      return ref.partialReferences[this.currentPartialPosition_];
    }
    return ref;
  }

  next(): IteratorResult<SegmentReference | null, SegmentReference | null> {
    const ref = this.segmentIndex_.get(this.currentPosition_);

    if (!this.reverse) {
      if (ref && ref.hasPartialSegments()) {
        // If the regular segment contains partial segments, move to the next
        // partial SegmentReference.
        this.currentPartialPosition_++;
        // If the current regular segment has been published completely, and
        // we've reached the end of its partial segments list, move to the next
        // regular segment.
        // If the Partial Segments list is still on the fly, do not move to
        // the next regular segment.
        if (ref.hasAllPartialSegments() && this.currentPartialPosition_ == ref.partialReferences.length) {
          this.currentPosition_++;
          this.currentPartialPosition_ = 0;
        }
      } else {
        // If the regular segment doesn't contain partial segments, move to the
        // next regular segment.
        this.currentPosition_++;
        this.currentPartialPosition_ = 0;
      }
    } else {
      if (ref && ref.hasPartialSegments()) {
        // If the regular segment contains partial segments, move to the
        // previous partial SegmentReference.
        this.currentPartialPosition_--;
        if (this.currentPartialPosition_ < 0) {
          this.currentPosition_--;
          const prevRef = this.segmentIndex_.get(this.currentPosition_);
          if (prevRef && prevRef.hasPartialSegments()) {
            this.currentPartialPosition_ = prevRef.partialReferences.length - 1;
          } else {
            this.currentPartialPosition_ = 0;
          }
        }
      } else {
        // If the regular segment doesn't contain partial segments, move to the
        // previous regular segment.
        this.currentPosition_--;
        this.currentPartialPosition_ = 0;
      }
    }
    const res = this.current();
    return {
      value: res,
      done: !res,
    };
  }
}

/**
 * A meta-SegmentIndex composed of multiple other SegmentIndexes.
 * Used in constructing multi-Period Streams for DASH.
 *
 * @extends shaka.media.SegmentIndex
 * @export
 */

export class MetaSegmentIndex extends SegmentIndex {
  private indexes_: SegmentIndex[];
  constructor() {
    super([]);

    this.indexes_ = [];
  }

  /**
   * Append a SegmentIndex to this MetaSegmentIndex.  This effectively stitches
   * the underlying Stream onto the end of the multi-Period Stream represented
   * by this MetaSegmentIndex.
   *
   * @param {!shaka.media.SegmentIndex} segmentIndex
   */
  appendSegmentIndex(segmentIndex: SegmentIndex) {
    asserts.assert(
      this.indexes_.length == 0 || segmentIndex.getNumEvicted() == 0,
      'Should not append a new segment index with already-evicted segments'
    );
    this.indexes_.push(segmentIndex);
  }

  /**
   * Create a clone of this MetaSegmentIndex containing all the same indexes.
   *
   * @return
   */
  clone() {
    const clone = new MetaSegmentIndex();
    // Be careful to clone the Array.  We don't want to share the reference with
    // our clone and affect each other accidentally.
    clone.indexes_ = this.indexes_.slice();
    return clone;
  }

  release() {
    for (const index of this.indexes_) {
      index.release();
    }

    this.indexes_ = [];
  }

  forEachTopLevelReference(fn: (r: SegmentReference) => void) {
    for (const index of this.indexes_) {
      index.forEachTopLevelReference(fn);
    }
  }

  find(time: number): number | null {
    let numPassedInEarlierIndexes = 0;
    for (const index of this.indexes_) {
      const position = index.find(time);
      if (position !== null) {
        return position + numPassedInEarlierIndexes;
      }

      numPassedInEarlierIndexes += index.getNumEvicted() + index.getNumReferences();
    }
    return null;
  }

  get(position: number) {
    let numPassedInEarlierIndexes = 0;
    let sawSegments = false;
    for (const index of this.indexes_) {
      asserts.assert(
        !sawSegments || index.getNumEvicted() == 0,
        'Should not see evicted segments after available segments'
      );
      const reference = index.get(position - numPassedInEarlierIndexes);

      if (reference) {
        return reference;
      }

      const num = index.getNumReferences();
      numPassedInEarlierIndexes += index.getNumEvicted() + num;
      sawSegments = sawSegments || num != 0;
    }
    return null;
  }

  /**
   * @override
   * @export
   */
  offset(offset: number) {
    // offset() is only used by HLS, and MetaSegmentIndex is only used for DASH.
    asserts.assert(false, 'offset() should not be used in MetaSegmentIndex!');
  }

  /**
   * @override
   * @export
   */
  merge(references: SegmentReference[]) {
    // merge() is only used internally by the DASH and HLS parser on
    // SegmentIndexes, but never on MetaSegmentIndex.
    asserts.assert(false, 'merge() should not be used in MetaSegmentIndex!');
  }

  /**
   * @override
   * @export
   */
  evict(time: number) {
    // evict() is only used internally by the DASH and HLS parser on
    // SegmentIndexes, but never on MetaSegmentIndex.
    asserts.assert(false, 'evict() should not be used in MetaSegmentIndex!');
  }

  /**
   * @override
   * @export
   */
  mergeAndEvict(references: SegmentReference[], windowStart: number) {
    // mergeAndEvict() is only used internally by the DASH and HLS parser on
    // SegmentIndexes, but never on MetaSegmentIndex.
    asserts.assert(false, 'mergeAndEvict() should not be used in MetaSegmentIndex!');
  }

  /**
   * @override
   * @export
   */
  fit(windowStart: number, windowEnd: number) {
    // fit() is only used internally by manifest parsers on SegmentIndexes, but
    // never on MetaSegmentIndex.
    asserts.assert(false, 'fit() should not be used in MetaSegmentIndex!');
  }

  /**
   * @override
   * @export
   */
  updateEvery(interval: number, updateCallback: () => SegmentReference[] | null) {
    // updateEvery() is only used internally by the DASH parser on
    // SegmentIndexes, but never on MetaSegmentIndex.
    asserts.assert(false, 'updateEvery() should not be used in MetaSegmentIndex!');
  }
}
