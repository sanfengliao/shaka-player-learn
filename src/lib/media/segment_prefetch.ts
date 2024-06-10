import { Stream } from '../../externs/shaka/manifest';
import { asserts } from '../debug/asserts';
import { log } from '../debug/log';
import { NetworkingEngine, PendingRequest } from '../net/network_engine';
import { Uint8ArrayUtils } from '../util/uint8array_utils';
import { InitSegmentReference, SegmentReference, SegmentReferenceStatus } from './segment_reference';

/**
 * @summary
 * This class manages segment prefetch operations.
 * Called by StreamingEngine to prefetch next N segments
 * ahead of playhead, to reduce the chances of rebuffering.
 */
export class SegmentPrefetch {
  private prefetchLimit_: number;
  private stream_: Stream;
  private fetchDispatcher_: FetchDispatcher;
  private segmentPrefetchMap_ = new Map<SegmentReference, SegmentPrefetchOperation>();
  private initSegmentPrefetchMap_ = new Map<InitSegmentReference, SegmentPrefetchOperation>();
  private prefetchPosTime_ = 0;
  constructor(prefetchLimit: number, stream: Stream, fetchDispatcher: FetchDispatcher) {
    this.prefetchLimit_ = prefetchLimit;
    this.stream_ = stream;
    this.fetchDispatcher_ = fetchDispatcher;
  }

  replaceFetchDispatcher(fetchDispatcher: FetchDispatcher) {
    this.fetchDispatcher_ = fetchDispatcher;
    for (const operation of this.segmentPrefetchMap_.values()) {
      operation.replaceFetchDispatcher(fetchDispatcher);
    }
  }

  /**
   * Fetch next segments ahead of current time.
   * @param currTime
   * @param skipFirst
   */
  prefetchSegmentsByTime(currTime: number, skipFirst = false) {
    asserts.assert(this.prefetchLimit_ > 0, 'SegmentPrefetch can not be used when prefetchLimit <= 0.');
    const logPrefix = SegmentPrefetch.logPrefix_(this.stream_);
    if (!this.stream_.segmentIndex) {
      log.debug(logPrefix, 'missing segmentIndex');
      return;
    }

    const maxTime = Math.max(currTime, this.prefetchPosTime_);
    const iterator = this.stream_.segmentIndex.getIteratorForTime(maxTime, /* allowNonIndepedent= */ true);
    if (!iterator) {
      return;
    }
    let reference = iterator.next().value;
    if (skipFirst) {
      reference = iterator.next().value;
    }
    if (!reference) {
      return;
    }

    while (this.segmentPrefetchMap_.size < this.prefetchLimit_ && reference != null) {
      // By default doesn't prefech preload partial segments when using
      // byterange
      let prefetchAllowed = true;
      if (reference.isPreload() && reference.endByte != null) {
        prefetchAllowed = false;
      }

      if (reference.getStatus() == SegmentReferenceStatus.MISSING) {
        prefetchAllowed = false;
      }

      if (prefetchAllowed && reference.initSegmentReference) {
        this.prefetchInitSegment(reference.initSegmentReference);
      }

      if (prefetchAllowed && !this.segmentPrefetchMap_.has(reference)) {
        const segmentPrefetchOperation = new SegmentPrefetchOperation(this.fetchDispatcher_);
        segmentPrefetchOperation.dispatchFetch(reference, this.stream_);
        this.segmentPrefetchMap_.set(reference, segmentPrefetchOperation);
      }
      this.prefetchPosTime_ = reference.startTime;

      if (this.stream_.fastSwitching && reference.isPartial() && reference.isLastPartial()) {
        break;
      }
      reference = iterator.next().value;
    }

    this.clearInitSegments_();
  }

  prefetchInitSegment(initSegmentReference: InitSegmentReference) {
    asserts.assert(this.prefetchLimit_ > 0, 'SegmentPrefetch can not be used when prefetchLimit <= 0.');

    const logPrefix = SegmentPrefetch.logPrefix_(this.stream_);
    if (!this.stream_.segmentIndex) {
      log.debug(logPrefix, 'missing segmentIndex');
      return;
    }

    // init segments are ignored from the prefetch limit
    const initSegments = Array.from(this.initSegmentPrefetchMap_.keys());
    const someReference = initSegments.some((reference) => {
      return InitSegmentReference.equal(reference, initSegmentReference);
    });

    if (!someReference) {
      const segmentPrefetchOperation = new SegmentPrefetchOperation(this.fetchDispatcher_);
      segmentPrefetchOperation.dispatchFetch(initSegmentReference, this.stream_);
      this.initSegmentPrefetchMap_.set(initSegmentReference, segmentPrefetchOperation);
    }
  }

  /**
   * Get the result of prefetched segment if already exists.
   * @param reference
   * @param streamDataCallback
   * @returns
   */
  getPrefetchedSegment(reference: InitSegmentReference | SegmentReference, streamDataCallback: StreamDataCallback) {
    asserts.assert(this.prefetchLimit_ > 0, 'SegmentPrefetch can not be used when prefetchLimit <= 0.');

    const logPrefix = SegmentPrefetch.logPrefix_(this.stream_);

    let prefetchMap: Map<InitSegmentReference | SegmentReference, SegmentPrefetchOperation> = this.segmentPrefetchMap_;
    if (reference instanceof InitSegmentReference) {
      prefetchMap = this.initSegmentPrefetchMap_;
    }

    if (prefetchMap.has(reference)) {
      const segmentPrefetchOperation = prefetchMap.get(reference)!;
      if (streamDataCallback) {
        segmentPrefetchOperation.setStreamDataCallback(streamDataCallback);
      }
      if (reference instanceof SegmentReference) {
        log.debug(logPrefix, 'reused prefetched segment at time:', reference.startTime, 'mapSize', prefetchMap.size);
      } else {
        log.debug(logPrefix, 'reused prefetched init segment at time, mapSize', prefetchMap.size);
      }
      return segmentPrefetchOperation.getOperation();
    } else {
      if (reference instanceof SegmentReference) {
        log.debug(logPrefix, 'missed segment at time:', reference.startTime, 'mapSize', prefetchMap.size);
      } else {
        log.debug(logPrefix, 'missed init segment at time, mapSize', prefetchMap.size);
      }
      return null;
    }
  }

  private clearMap_(map: Map<InitSegmentReference | SegmentReference, SegmentPrefetchOperation>) {
    for (const reference of map.keys()) {
      if (reference) {
        this.abortPrefetchedSegment_(reference);
      }
    }
  }

  clearAll() {
    this.clearMap_(this.segmentPrefetchMap_);
    this.clearMap_(this.initSegmentPrefetchMap_);
    const logPrefix = SegmentPrefetch.logPrefix_(this.stream_);
    log.debug(logPrefix, 'cleared all');
    this.prefetchPosTime_ = 0;
  }

  removeReference(reference: SegmentReference) {
    this.abortPrefetchedSegment_(reference);
  }

  evict(time: number, clearInitSegments = false) {
    for (const ref of this.segmentPrefetchMap_.keys()) {
      if (time > ref.endTime) {
        this.abortPrefetchedSegment_(ref);
      }
    }
    if (clearInitSegments) {
      this.clearInitSegments_();
    }
  }

  /**
   * Remove all init segments that don't have associated segments in
   * the segment prefetch map.
   * By default, with delete on get, the init segments should get removed as
   * they are used. With deleteOnGet set to false, we need to clear them
   * every so often once the segments that are associated with each init segment
   * is no longer prefetched.
   */
  private clearInitSegments_() {
    const segmentReferences = Array.from(this.segmentPrefetchMap_.keys());
    for (const initSegmentReference of this.initSegmentPrefetchMap_.keys()) {
      // if no segment references this init segment, we should remove it.
      const someReference = segmentReferences.some((segmentReference) => {
        return InitSegmentReference.equal(segmentReference.initSegmentReference, initSegmentReference);
      });
      if (!someReference) {
        this.abortPrefetchedSegment_(initSegmentReference);
      }
    }
  }

  /**
   * Reset the prefetchLimit and clear all internal states.
   * Called by StreamingEngine when configure() was called.
   * @param newPrefetchLimit
   */
  resetLimit(newPrefetchLimit: number) {
    asserts.assert(newPrefetchLimit >= 0, 'The new prefetch limit must be >= 0.');

    const logPrefix = SegmentPrefetch.logPrefix_(this.stream_);
    log.debug(logPrefix, 'resetting prefetch limit to', newPrefetchLimit);
    this.prefetchLimit_ = newPrefetchLimit;

    const keyArr = Array.from(this.segmentPrefetchMap_.keys());
    while (keyArr.length > newPrefetchLimit) {
      const reference = keyArr.pop();
      if (reference) {
        this.abortPrefetchedSegment_(reference);
      }
    }
    this.clearInitSegments_();
  }

  /**
   * Remove a segment from prefetch map and abort it.
   * @param reference
   */
  abortPrefetchedSegment_(reference: InitSegmentReference | SegmentReference) {
    const logPrefix = SegmentPrefetch.logPrefix_(this.stream_);

    let prefetchMap: Map<InitSegmentReference | SegmentReference, SegmentPrefetchOperation> = this.segmentPrefetchMap_;
    if (reference instanceof InitSegmentReference) {
      prefetchMap = this.initSegmentPrefetchMap_;
    }
    const segmentPrefetchOperation = prefetchMap.get(reference);
    prefetchMap.delete(reference);

    if (segmentPrefetchOperation) {
      segmentPrefetchOperation.abort();
      if (reference instanceof SegmentReference) {
        log.debug(logPrefix, 'pop and abort prefetched segment at time:', reference.startTime);
      } else {
        log.debug(logPrefix, 'pop and abort prefetched init segment');
      }
    }
  }

  getLastKnownPosition() {
    return this.prefetchPosTime_;
  }

  /**
   * Get the current stream.
   */
  getStream() {
    return this.stream_;
  }

  /**
   * Called by Streaming Engine when switching variant.
   */
  switchStream(stream: Stream) {
    if (stream && stream !== this.stream_) {
      this.clearAll();
      this.stream_ = stream;
    }
  }

  static logPrefix_(stream: Stream) {
    return 'SegmentPrefetch(' + stream.type + ':' + stream.id + ')';
  }
}

/**
 * @summary
 * This class manages a segment prefetch operation.
 */
export class SegmentPrefetchOperation {
  fetchDispatcher_: FetchDispatcher;
  streamDataCallback_: StreamDataCallback = null;
  operation_: PendingRequest | null = null;
  constructor(fetchDispatcher: FetchDispatcher) {
    this.fetchDispatcher_ = fetchDispatcher;
  }

  replaceFetchDispatcher(fetchDispatcher: FetchDispatcher) {
    this.fetchDispatcher_ = fetchDispatcher;
  }

  dispatchFetch(reference: InitSegmentReference | SegmentReference, stream: Stream) {
    // We need to store the data, because streamDataCallback_ might not be
    // available when you start getting the first data.
    let buffer = new Uint8Array(0);
    this.operation_ = this.fetchDispatcher_(reference, stream, async (data) => {
      if (buffer.byteLength > 0) {
        buffer = Uint8ArrayUtils.concat(buffer, data);
      } else {
        buffer = data as Uint8Array;
      }

      if (this.streamDataCallback_) {
        await this.streamDataCallback_(buffer);
        buffer = new Uint8Array(0);
      }
    });
  }

  getOperation() {
    return this.operation_;
  }

  setStreamDataCallback(streamDataCallback: StreamDataCallback) {
    this.streamDataCallback_ = streamDataCallback;
  }

  abort() {
    if (this.operation_) {
      this.operation_.abort();
    }
  }
}

export type StreamDataCallback = ((data: BufferSource) => Promise<void>) | null;

/**
 *  A callback function that fetches a segment.
 */
export type FetchDispatcher = (
  ref: InitSegmentReference | SegmentReference,
  stream: Stream,
  callback: StreamDataCallback
) => PendingRequest;
