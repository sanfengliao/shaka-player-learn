import { StreamingConfiguration } from '../../externs/shaka';
import { SpatialVideoInfo } from '../../externs/shaka/codecs';
import { AesKey, Manifest, Stream, Variant } from '../../externs/shaka/manifest';
import { ParsedBox } from '../../externs/shaka/mp4_parser';
import { RetryParameters } from '../../externs/shaka/net';
import { asserts } from '../debug/asserts';
import { log } from '../debug/log';
import { Backoff } from '../net/backoff';
import {
  NetworkingEngine,
  NetworkingEngineAdvancedRequestType,
  NetworkingEngineRequestType,
  PendingRequest,
} from '../net/network_engine';
import { BufferUtils } from '../util/buffer_utils';
import { DelayedTick } from '../util/delayed_tick';
import { Destroyer } from '../util/destroyer';
import { ShakaError } from '../util/error';
import { FakeEvent } from '../util/fake_event';
import { IDestroyable } from '../util/i_destroyable';
import { Id3Utils } from '../util/id3_utils';
import { LanguageUtils } from '../util/language_utils';
import { ManifestParserUtils } from '../util/manifest_parser_utils';
import { MimeUtils } from '../util/mime_utils';
import { Mp4BoxParsers } from '../util/mp4_box_parsers';
import { Mp4Parser } from '../util/mp4_parser';
import { Networking } from '../util/networking';
import { ManifestParser } from './manifest_parser';
import { MediaSourceEngine, OnMetadata } from './media_source_engine';
import { SegmentIterator } from './segment_index';
import { SegmentPrefetch, StreamDataCallback } from './segment_prefetch';
import { InitSegmentReference, SegmentReference, SegmentReferenceStatus } from './segment_reference';
const ContentType = ManifestParserUtils.ContentType;
/**
 * @summary Creates a Streaming Engine.
 * The StreamingEngine is responsible for setting up the Manifest's Streams
 * (i.e., for calling each Stream's createSegmentIndex() function), for
 * downloading segments, for co-ordinating audio, video, and text buffering.
 * The StreamingEngine provides an interface to switch between Streams, but it
 * does not choose which Streams to switch to.
 *
 * The StreamingEngine does not need to be notified about changes to the
 * Manifest's SegmentIndexes; however, it does need to be notified when new
 * Variants are added to the Manifest.
 *
 * To start the StreamingEngine the owner must first call configure(), followed
 * by one call to switchVariant(), one optional call to switchTextStream(), and
 * finally a call to start().  After start() resolves, switch*() can be used
 * freely.
 *
 * The owner must call seeked() each time the playhead moves to a new location
 * within the presentation timeline; however, the owner may forego calling
 * seeked() when the playhead moves outside the presentation timeline.
 *
 */
export class StreamingEngine implements IDestroyable {
  private playerInterface_: StreamingEnginePlayerInterface;
  private manifest_: Manifest;
  private config_: StreamingConfiguration = null as any;
  private bufferingGoalScale_ = 1;
  private currentVariant_: Variant | null = null;
  private currentTextStream_: Stream = null as any;
  private textStreamSequenceId_ = 0;
  private parsedPrftEventRaised_ = false;
  private mediaStates_ = new Map<string, MediaState>();
  //  Set to true once the initial media states have been created.
  private startupComplete_ = false;
  private failureCallbackBackoff_: Backoff = null as any;
  // Set to true on fatal error.  Interrupts fetchAndAppend_().
  private fatalError_ = false;

  private destroyer_ = new Destroyer(() => this.doDestroy_());

  private lastMediaSourceReset_ = Date.now() / 1000;

  private audioPrefetchMap_ = new Map<Stream, SegmentPrefetch>();

  private spatialVideoInfo_: SpatialVideoInfo = {
    projection: null,
    hfov: null,
  };

  constructor(manifest: Manifest, playerInterface: StreamingEnginePlayerInterface) {
    this.playerInterface_ = playerInterface;
    this.manifest_ = manifest;
  }

  private async doDestroy_() {
    const aborts = [];

    for (const state of this.mediaStates_.values()) {
      this.cancelUpdate_(state);
      aborts.push(this.abortOperations_(state));
    }
    for (const prefetch of this.audioPrefetchMap_.values()) {
      prefetch.clearAll();
    }

    await Promise.all(aborts);

    this.mediaStates_.clear();
    this.audioPrefetchMap_.clear();

    this.playerInterface_ = null as any;
    this.manifest_ = null as any;
    this.config_ = null as any;
  }

  destroy() {
    return this.destroyer_.destroy();
  }

  /**
   * Called by the Player to provide an updated configuration any time it
   * changes. Must be called at least once before start().
   * @param config
   */
  configure(config: StreamingConfiguration) {
    this.config_ = config;
    // Create separate parameters for backoff during streaming failure.

    const failureRetryParams: RetryParameters = {
      // The term "attempts" includes the initial attempt, plus all retries.
      // In order to see a delay, there would have to be at least 2 attempts.
      maxAttempts: Math.max(config.retryParameters.maxAttempts, 2),
      baseDelay: config.retryParameters.baseDelay,
      backoffFactor: config.retryParameters.backoffFactor,
      fuzzFactor: config.retryParameters.fuzzFactor,
      timeout: 0, // irrelevant
      stallTimeout: 0, // irrelevant
      connectionTimeout: 0, // irrelevant
    };
    // We don't want to ever run out of attempts.  The application should be
    // allowed to retry streaming infinitely if it wishes.
    const autoReset = true;
    this.failureCallbackBackoff_ = new Backoff(failureRetryParams, autoReset);

    // disable audio segment prefetch if this is now set
    if (config.disableAudioPrefetch) {
      const state = this.mediaStates_.get(ContentType.AUDIO);
      if (state && state.segmentPrefetch) {
        state.segmentPrefetch.clearAll();
        state.segmentPrefetch = null;
      }

      for (const stream of this.audioPrefetchMap_.keys()) {
        const prefetch = this.audioPrefetchMap_.get(stream);
        prefetch!.clearAll();
        this.audioPrefetchMap_.delete(stream);
      }
    }

    // disable text segment prefetch if this is now set
    // TODO(sanfeng): TextEngine
    if (config.disableTextPrefetch) {
      const state = this.mediaStates_.get(ContentType.TEXT);
      if (state && state.segmentPrefetch) {
        state.segmentPrefetch.clearAll();
        state.segmentPrefetch = null;
      }
    }

    // disable video segment prefetch if this is now set
    if (config.disableVideoPrefetch) {
      const state = this.mediaStates_.get(ContentType.VIDEO);
      if (state && state.segmentPrefetch) {
        state.segmentPrefetch.clearAll();
        state.segmentPrefetch = null;
      }
    }

    // Allow configuring the segment prefetch in middle of the playback.
    for (const type of this.mediaStates_.keys()) {
      const state = this.mediaStates_.get(type)!;
      if (state.segmentPrefetch) {
        state.segmentPrefetch.resetLimit(config.segmentPrefetchLimit);
        if (!(config.segmentPrefetchLimit > 0)) {
          // ResetLimit is still needed in this case,
          // to abort existing prefetch operations.
          state.segmentPrefetch = null;
        }
      } else if (config.segmentPrefetchLimit > 0) {
        state.segmentPrefetch = this.createSegmentPrefetch_(state.stream);
      }
    }
    if (!config.disableAudioPrefetch) {
      this.updatePrefetchMapForAudio_();
    }
  }

  /**
   *  Initialize and start streaming.
   *
   * By calling this method, StreamingEngine will start streaming the variant
   * chosen by a prior call to switchVariant(), and optionally, the text stream
   * chosen by a prior call to switchTextStream().  Once the Promise resolves,
   * switch*() may be called freely.
   * @param segmentPrefetchById  If provided, segments prefetched for these streams will be used as needed
   *   during playback.
   */
  async start(segmentPrefetchById: Map<number, SegmentPrefetch>) {
    asserts.assert(this.config_, 'StreamingEngine configure() must be called before init()!');

    // Setup the initial set of Streams and then begin each update cycle.
    await this.initStreams_(segmentPrefetchById || new Map());
    this.destroyer_.ensureNotDestroyed();

    log.debug('init: completed initial Stream setup');
    this.startupComplete_ = true;
  }

  /**
   * Get the current variant we are streaming.  Returns null if nothing is
   * streaming.
   */
  getCurrentVariant() {
    return this.currentVariant_;
  }

  /**
   * Get the text stream we are streaming.  Returns null if there is no text
   * streaming.
   */
  getCurrentTextStream() {
    return this.currentTextStream_;
  }
  /**
   * Start streaming text, creating a new media state.
   * @param stream
   */
  async loadNewTextStream_(stream: Stream) {
    // TODO(sanfeng): TextEngine
  }

  /**
   * Stop fetching text stream when the user chooses to hide the captions.
   */
  unloadTextStream() {
    // TODO(sanfeng): TextEngine
  }

  /**
   * Set trick play on or off.
   * If trick play is on, related trick play streams will be used when possible.
   * @param on
   */
  setTrickPlay(on: boolean) {
    this.updateSegmentIteratorReverse_();

    const mediaState = this.mediaStates_.get(ContentType.VIDEO);
    if (!mediaState) {
      return;
    }

    const stream = mediaState.stream;
    if (!stream) {
      return;
    }

    log.debug('setTrickPlay', on);
    if (on) {
      const trickModeVideo = stream.trickModeVideo;
      if (!trickModeVideo) {
        return; // Can't engage trick play.
      }

      const normalVideo = mediaState.restoreStreamAfterTrickPlay;
      if (normalVideo) {
        return; // Already in trick play.
      }

      log.debug('Engaging trick mode stream', trickModeVideo);
      this.switchInternal_(trickModeVideo, /* clearBuffer= */ false, /* safeMargin= */ 0, /* force= */ false);

      mediaState.restoreStreamAfterTrickPlay = stream;
    } else {
      const normalVideo = mediaState.restoreStreamAfterTrickPlay;
      if (!normalVideo) {
        return;
      }

      log.debug('Restoring non-trick-mode stream', normalVideo);
      mediaState.restoreStreamAfterTrickPlay = null;
      this.switchInternal_(normalVideo, /* clearBuffer= */ true, /* safeMargin= */ 0, /* force= */ false);
    }
  }

  /**
   *
   * @param variant
   * @param clearBuffer
   * @param safeMargin
   * @param force If true, reload the variant even if it did not change.
   * @param adaptation  If true, update the media state to indicate MediaSourceEngine should
   *   reset the timestamp offset to ensure the new track segments are correctly
   *   placed on the timeline.
   */
  switchVariant(variant: Variant, clearBuffer = false, safeMargin = 0, force = false, adaptation = false) {
    this.currentVariant_ = variant;

    if (!this.startupComplete_) {
      return;
    }

    if (variant.video) {
      this.switchInternal_(
        variant.video,
        /* clearBuffer= */ clearBuffer,
        /* safeMargin= */ safeMargin,
        /* force= */ force,
        /* adaptation= */ adaptation
      );
    }
    if (variant.audio) {
      this.switchInternal_(
        variant.audio,
        /* clearBuffer= */ clearBuffer,
        /* safeMargin= */ safeMargin,
        /* force= */ force,
        /* adaptation= */ adaptation
      );
    }
  }

  async switchTextStream(textStream: Stream) {
    // TODO(sanfeng): TextEngine
  }

  /**
   *  Switches to the given Stream. |stream| may be from any Variant.
   * @param stream
   * @param clearBuffer
   * @param safeMargin
   * @param force
   * @param adaptation
   */
  switchInternal_(
    stream: Stream,
    clearBuffer: boolean,
    safeMargin: number,
    force: boolean,
    adaptation: boolean = false
  ) {
    const type = stream.type;

    const mediaState = this.mediaStates_.get(type);

    // TODO(sanfeng): TextEngine
    // if (!mediaState && stream.type === ContentType.TEXT) {
    //   this.loadNewTextStream_(stream);
    //   return;
    // }

    asserts.assert(mediaState, 'switch: expected mediaState to exist');
    if (!mediaState) {
      return;
    }

    if (mediaState.restoreStreamAfterTrickPlay) {
      log.debug('switch during trick play mode', stream);

      // Already in trick play mode, so stick with trick mode tracks if
      // possible.
      if (stream.trickModeVideo) {
        // Use the trick mode stream, but revert to the new selection later.
        mediaState.restoreStreamAfterTrickPlay = stream;
        stream = stream.trickModeVideo;
        log.debug('switch found trick play stream', stream);
      } else {
        // There is no special trick mode video for this stream!
        mediaState.restoreStreamAfterTrickPlay = null;
        log.debug('switch found no special trick play stream');
      }
    }

    if (mediaState.stream == stream && !force) {
      const streamTag = StreamingEngine.logPrefix_(mediaState);
      log.debug('switch: Stream ' + streamTag + ' already active');
      return;
    }
    if (this.audioPrefetchMap_.has(stream)) {
      mediaState.segmentPrefetch = this.audioPrefetchMap_.get(stream)!;
    } else if (mediaState.segmentPrefetch) {
      mediaState.segmentPrefetch.switchStream(stream);
    }

    if (stream.type == ContentType.TEXT) {
      // TODO(sanfeng): TextEngine
    }

    // Releases the segmentIndex of the old stream.
    // Do not close segment indexes we are prefetching.
    if (!this.audioPrefetchMap_.has(mediaState.stream)) {
      if (mediaState.stream.closeSegmentIndex) {
        mediaState.stream.closeSegmentIndex();
      }
    }
    mediaState.stream = stream;
    mediaState.segmentIterator = null;
    mediaState.adaptation = adaptation;
    const streamTag = StreamingEngine.logPrefix_(mediaState);
    log.debug('switch: switching to Stream ' + streamTag);
    if (clearBuffer) {
      if (mediaState.clearingBuffer) {
        // We are already going to clear the buffer, but make sure it is also
        // flushed.
        mediaState.waitingToFlushBuffer = true;
      } else if (mediaState.performingUpdate) {
        // We are performing an update, so we have to wait until it's finished.
        // onUpdate_() will call clearBuffer_() when the update has finished.
        // We need to save the safe margin because its value will be needed when
        // clearing the buffer after the update.
        mediaState.waitingToClearBuffer = true;
        mediaState.clearBufferSafeMargin = safeMargin;
        mediaState.waitingToFlushBuffer = true;
      } else {
        // Cancel the update timer, if any.
        this.cancelUpdate_(mediaState);
        // Clear right away.
        this.clearBuffer_(mediaState, /* flush= */ true, safeMargin).catch((error: any) => {
          if (this.playerInterface_) {
            asserts.assert(error instanceof ShakaError, 'Wrong error type!');
            this.playerInterface_.onError(error);
          }
        });
      }
    }

    this.makeAbortDecision_(mediaState).catch((error: any) => {
      if (this.playerInterface_) {
        asserts.assert(error instanceof ShakaError, 'Wrong error type!');
        this.playerInterface_.onError(error);
      }
    });
  }

  /**
   * Decide if it makes sense to abort the current operation, and abort it if
   * so.
   * @param mediaState
   */
  private async makeAbortDecision_(mediaState: MediaState) {
    // If the operation is completed, it will be set to null, and there's no
    // need to abort the request.
    if (!mediaState.operation) {
      return;
    }

    const originalStream = mediaState.stream;
    const originalOperation = mediaState.operation;

    if (!originalStream.segmentIndex) {
      // Create the new segment index so the time taken is accounted for when
      // deciding whether to abort.
      await originalStream.createSegmentIndex();
    }

    if (mediaState.operation != originalOperation) {
      // The original operation completed while we were getting a segment index,
      // so there's nothing to do now.
      return;
    }

    if (mediaState.stream != originalStream) {
      // The stream changed again while we were getting a segment index.  We
      // can't carry out this check, since another one might be in progress by
      // now.
      return;
    }

    asserts.assert(mediaState.stream.segmentIndex, 'Segment index should exist by now!');

    if (this.shouldAbortCurrentRequest_(mediaState)) {
      log.info('Aborting current segment request.');
      mediaState.operation.abort();
    }
  }

  /**
   * Returns whether we should abort the current request.
   * @param mediaState
   */
  private shouldAbortCurrentRequest_(mediaState: MediaState): boolean {
    asserts.assert(mediaState.operation, 'Abort logic requires an ongoing operation!');
    asserts.assert(mediaState.stream && mediaState.stream.segmentIndex, 'Abort logic requires a segment index');

    const presentationTime = this.playerInterface_.getPresentationTime();
    const bufferEnd = this.playerInterface_.mediaSourceEngine.bufferEnd(mediaState.type);

    const timeNeeded = this.getTimeNeeded_(mediaState, presentationTime);
    const index = mediaState.stream.segmentIndex!.find(timeNeeded);
    const newSegment = index == null ? null : mediaState.stream.segmentIndex!.get(index);

    let newSegmentSize = newSegment ? newSegment.getSize() : null;
    if (newSegment && !newSegmentSize) {
      // compute approximate segment size using stream bandwidth
      const duration = newSegment.getEndTime() - newSegment.getStartTime();
      const bandwidth = mediaState.stream.bandwidth || 0;
      // bandwidth is in bits per second, and the size is in bytes
      newSegmentSize = (duration * bandwidth) / 8;
    }

    if (!newSegmentSize) {
      return false;
    }

    // When switching, we'll need to download the init segment.
    const init = newSegment!.initSegmentReference;
    if (init) {
      newSegmentSize += init.getSize() || 0;
    }
    const bandwidthEstimate = this.playerInterface_.getBandwidthEstimate();

    // The estimate is in bits per second, and the size is in bytes.  The time
    // remaining is in seconds after this calculation.
    const timeToFetchNewSegment = (newSegmentSize * 8) / bandwidthEstimate;

    // If the new segment can be finished in time without risking a buffer
    // underflow, we should abort the old one and switch.
    const bufferedAhead = (bufferEnd || 0) - presentationTime;
    const safetyBuffer = Math.max(this.manifest_.minBufferTime || 0, this.config_.rebufferingGoal);
    const safeBufferedAhead = bufferedAhead - safetyBuffer;
    // 满足 presentationTime + safetyBuffer + timeToFetchNewSegment > bufferEnd
    if (timeToFetchNewSegment < safeBufferedAhead) {
      return true;
    }

    // If the thing we want to switch to will be done more quickly than what
    // we've got in progress, we should abort the old one and switch.
    // 现在正在还没完成下载的数据 比切换所需的数据多，那就直接暂停当前正在下载的请求
    const bytesRemaining = mediaState.operation!.getBytesRemaining();
    if (bytesRemaining > newSegmentSize) {
      return true;
    }
    // Otherwise, complete the operation in progress.
    return false;
  }

  /**
   * Gets the next timestamp needed. Returns the playhead's position if the
   * buffer is empty; otherwise, returns the time at which the last segment
   * appended ends.
   *
   * @param mediaState
   * @param presentationTime
   * @return The next timestamp needed.
   * @private
   */
  private getTimeNeeded_(mediaState: MediaState, presentationTime: number) {
    // Get the next timestamp we need. We must use |lastSegmentReference|
    // to determine this and not the actual buffer for two reasons:
    //   1. Actual segments end slightly before their advertised end times, so
    //      the next timestamp we need is actually larger than |bufferEnd|.
    //   2. There may be drift (the timestamps in the segments are ahead/behind
    //      of the timestamps in the manifest), but we need drift-free times
    //      when comparing times against the presentation timeline.
    if (!mediaState.lastSegmentReference) {
      return presentationTime;
    }

    return mediaState.lastSegmentReference.endTime;
  }

  /**
   * Notifies the StreamingEngine that the playhead has moved to a valid time
   * within the presentation timeline.
   */
  seeked() {
    if (!this.playerInterface_) {
      // Already destroyed.
      return;
    }

    const presentationTime = this.playerInterface_.getPresentationTime();
    const newTimeIsBuffered = (type: string) => {
      return this.playerInterface_.mediaSourceEngine.isBuffered(type, presentationTime);
    };

    let streamCleared = false;
    for (const type of this.mediaStates_.keys()) {
      const mediaState = this.mediaStates_.get(type)!;
      const logPrefix = StreamingEngine.logPrefix_(mediaState);

      let segment = null;
      if (mediaState.segmentIterator) {
        segment = mediaState.segmentIterator.current();
      }
      // Only reset the iterator if we seek outside the current segment.
      // 当seek到了当前buffer之外之后，就把segmentIterator设置为null，这样子就会重新生成segmentIterator
      if (!segment || segment.startTime > presentationTime || segment.endTime < presentationTime) {
        mediaState.segmentIterator = null;
      }

      if (!newTimeIsBuffered(type)) {
        const bufferEnd = this.playerInterface_.mediaSourceEngine.bufferEnd(type);
        const somethingBuffered = bufferEnd !== null;
        // Don't clear the buffer unless something is buffered.  This extra
        // check prevents extra, useless calls to clear the buffer.
        if (somethingBuffered || mediaState.performingUpdate) {
          this.forceClearBuffer_(mediaState);
          streamCleared = true;
        }

        // If there is an operation in progress, stop it now.
        if (mediaState.operation) {
          mediaState.operation.abort();
          log.debug(logPrefix, 'Aborting operation due to seek');
          mediaState.operation = null;
        }

        // The pts has shifted from the seek, invalidating captions currently
        // in the text buffer. Thus, clear and reset the caption parser.
        // TODO(safeng): TextEngine
        if (type === ContentType.TEXT) {
          this.playerInterface_.mediaSourceEngine.resetCaptionParser();
        }

        // Mark the media state as having seeked, so that the new buffers know
        // that they will need to be at a new position (for sequence mode).
        mediaState.seeked = true;
      }
    }

    if (!streamCleared) {
      log.debug('(all): seeked: buffered seek: presentationTime=' + presentationTime);
    }
  }

  /**
   * Clear the buffer for a given stream.  Unlike clearBuffer_, this will handle
   * cases where a MediaState is performing an update.  After this runs, the
   * MediaState will have a pending update.
   * @param mediaState
   */
  forceClearBuffer_(mediaState: MediaState) {
    const logPrefix = StreamingEngine.logPrefix_(mediaState);

    if (mediaState.clearingBuffer) {
      // We're already clearing the buffer, so we don't need to clear the
      // buffer again.
      log.debug(logPrefix, 'clear: already clearing the buffer');
      return;
    }

    if (mediaState.waitingToClearBuffer) {
      // May not be performing an update, but an update will still happen.
      // See: https://github.com/shaka-project/shaka-player/issues/334
      log.debug(logPrefix, 'clear: already waiting');
      return;
    }

    if (mediaState.performingUpdate) {
      // We are performing an update, so we have to wait until it's finished.
      // onUpdate_() will call clearBuffer_() when the update has finished.
      log.debug(logPrefix, 'clear: currently updating');
      mediaState.waitingToClearBuffer = true;
      // We can set the offset to zero to remember that this was a call to
      // clearAllBuffers.
      mediaState.clearBufferSafeMargin = 0;
      return;
    }

    const type = mediaState.type;
    if (this.playerInterface_.mediaSourceEngine.bufferStart(type) == null) {
      // Nothing buffered.
      log.debug(logPrefix, 'clear: nothing buffered');
      if (mediaState.updateTimer === null) {
        // Note: an update cycle stops when we buffer to the end of the
        // presentation, or when we raise an error.
        this.scheduleUpdate_(mediaState, 0);
      }
      return;
    }

    // An update may be scheduled, but we can just cancel it and clear the
    // buffer right away. Note: clearBuffer_() will schedule the next update.
    log.debug(logPrefix, 'clear: handling right now');
    this.cancelUpdate_(mediaState);
    this.clearBuffer_(mediaState, /* flush= */ false, 0).catch((error: any) => {
      if (this.playerInterface_) {
        asserts.assert(error instanceof ShakaError, 'Wrong error type!');
        this.playerInterface_.onError(error);
      }
    });
  }

  /**
   * Initializes the initial streams and media states.  This will schedule
   * updates for the given types.
   *
   * @private
   */
  async initStreams_(segmentPrefetchById: Map<number, SegmentPrefetch>) {
    asserts.assert(this.config_, 'StreamingEngine configure() must be called before init()!');
    if (!this.currentVariant_) {
      log.error('init: no Streams chosen');
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.STREAMING,
        ShakaError.Code.STREAMING_ENGINE_STARTUP_INVALID_STATE
      );
    }

    const streamsByType = new Map<string, Stream>();
    const streams = new Set<Stream>();
    if (this.currentVariant_.audio) {
      streamsByType.set(ContentType.AUDIO, this.currentVariant_.audio);
      streams.add(this.currentVariant_.audio);
    }

    if (this.currentVariant_.video) {
      streamsByType.set(ContentType.VIDEO, this.currentVariant_.video);
      streams.add(this.currentVariant_.video);
    }

    // TODO(sanfeng): TextEngine
    if (this.currentTextStream_) {
      streamsByType.set(ContentType.TEXT, this.currentTextStream_);
      streams.add(this.currentTextStream_);
    }

    // Init MediaSourceEngine.
    const mediaSourceEngine = this.playerInterface_.mediaSourceEngine;

    await mediaSourceEngine.init(
      streamsByType,
      this.manifest_.sequenceMode,
      this.manifest_.type,
      this.manifest_.ignoreManifestTimestampsInSegmentsMode
    );
    this.destroyer_.ensureNotDestroyed();
    this.updateDuration();

    for (const type of streamsByType.keys()) {
      const stream = streamsByType.get(type)!;
      if (!this.mediaStates_.has(type)) {
        const mediaState = this.createMediaState_(stream);
        if (segmentPrefetchById.has(stream.id)) {
          const segmentPrefetch = segmentPrefetchById.get(stream.id)!;
          segmentPrefetch.replaceFetchDispatcher((reference, stream, streamDataCallback) => {
            return this.dispatchFetch_(reference, stream, streamDataCallback);
          });
          mediaState.segmentPrefetch = segmentPrefetch;
        }
        this.mediaStates_.set(type, mediaState);
        this.scheduleUpdate_(mediaState, 0);
      }
    }
  }

  /**
   * Sets the MediaSource's duration.
   */
  updateDuration() {
    const duration = this.manifest_.presentationTimeline.getDuration();
    if (duration < Infinity) {
      this.playerInterface_.mediaSourceEngine.setDuration(duration);
    } else {
      // To set the media source live duration as Infinity
      // If infiniteLiveStreamDuration as true
      const duration = this.config_.infiniteLiveStreamDuration ? Infinity : Math.pow(2, 32);
      // Not all platforms support infinite durations, so set a finite duration
      // so we can append segments and so the user agent can seek.
      this.playerInterface_.mediaSourceEngine.setDuration(duration);
    }
  }

  /**
   * Fetches the given segment.
   *
   * @param stream
   * @param
   *   reference
   * @param streamDataCallback
   *
   * @return
   * @private
   */
  private dispatchFetch_(
    reference: InitSegmentReference | SegmentReference,
    stream: Stream,
    streamDataCallback: StreamDataCallback
  ) {
    asserts.assert(this.playerInterface_.netEngine, 'Must have net engine');
    return StreamingEngine.dispatchFetch(
      reference,
      stream,
      streamDataCallback || null,
      this.config_.retryParameters,
      this.playerInterface_.netEngine
    );
  }

  /**
   * Creates a media state.
   *
   * @param {shaka.extern.Stream} stream
   * @return {shaka.media.StreamingEngine.MediaState_}
   * @private
   */
  private createMediaState_(stream: Stream): MediaState {
    return {
      stream,
      type: stream.type,
      segmentIterator: null,
      segmentPrefetch: this.createSegmentPrefetch_(stream),
      lastSegmentReference: null,
      lastInitSegmentReference: null,
      lastTimestampOffset: null,
      lastAppendWindowStart: null,
      lastAppendWindowEnd: null,
      restoreStreamAfterTrickPlay: null,
      endOfStream: false,
      performingUpdate: false,
      updateTimer: null,
      waitingToClearBuffer: false,
      clearBufferSafeMargin: 0,
      waitingToFlushBuffer: false,
      clearingBuffer: false,
      // The playhead might be seeking on startup, if a start time is set, so
      // start "seeked" as true.
      seeked: true,
      recovering: false,
      hasError: false,
      operation: null,
      lastCodecs: null,
      lastMimeType: null,
    };
  }

  /**
   *
   * @param stream
   */
  private createSegmentPrefetch_(stream: Stream): SegmentPrefetch | null {
    if (stream.type === ContentType.VIDEO && this.config_.disableVideoPrefetch) {
      return null;
    }
    if (stream.type === ContentType.AUDIO && this.config_.disableAudioPrefetch) {
      return null;
    }
    const CEA608_MIME = MimeUtils.CEA608_CLOSED_CAPTION_MIMETYPE;
    const CEA708_MIME = MimeUtils.CEA708_CLOSED_CAPTION_MIMETYPE;
    if (stream.type === ContentType.TEXT && (stream.mimeType == CEA608_MIME || stream.mimeType == CEA708_MIME)) {
      return null;
    }
    if (stream.type === ContentType.TEXT && this.config_.disableTextPrefetch) {
      return null;
    }

    if (this.audioPrefetchMap_.has(stream)) {
      return this.audioPrefetchMap_.get(stream)!;
    }
    const type = stream.type;
    const mediaState = this.mediaStates_.get(type);
    const currentSegmentPrefetch = mediaState && mediaState.segmentPrefetch;
    if (currentSegmentPrefetch && stream === currentSegmentPrefetch.getStream()) {
      return currentSegmentPrefetch;
    }
    if (this.config_.segmentPrefetchLimit > 0) {
      return new SegmentPrefetch(this.config_.segmentPrefetchLimit, stream, (reference, stream, streamDataCallback) => {
        return this.dispatchFetch_(reference, stream, streamDataCallback);
      });
    }
    return null;
  }

  /**
   * Populates the prefetch map depending on the configuration
   */
  private updatePrefetchMapForAudio_() {
    const prefetchLimit = this.config_.segmentPrefetchLimit;
    const prefetchLanguages = this.config_.prefetchAudioLanguages;
    for (const variant of this.manifest_.variants) {
      if (!variant.audio) {
        continue;
      }
      if (this.audioPrefetchMap_.has(variant.audio)) {
        // if we already have a segment prefetch,
        // update it's prefetch limit and if the new limit isn't positive,
        // remove the segment prefetch from our prefetch map.
        const prefetch = this.audioPrefetchMap_.get(variant.audio)!;
        prefetch.resetLimit(prefetchLimit);
        if (
          !(prefetchLimit > 0) ||
          !prefetchLanguages.some((lang) => LanguageUtils.areLanguageCompatible(variant.audio!.language, lang))
        ) {
          const type = variant.audio.type;
          const mediaState = this.mediaStates_.get(type);
          const currentSegmentPrefetch = mediaState && mediaState.segmentPrefetch;
          // if this prefetch isn't the current one, we want to clear it
          if (prefetch !== currentSegmentPrefetch) {
            prefetch.clearAll();
          }
          this.audioPrefetchMap_.delete(variant.audio);
        }
        continue;
      }

      // don't try to create a new segment prefetch if the limit isn't positive.
      if (prefetchLimit <= 0) {
        continue;
      }

      // only create a segment prefetch if its language is configured
      // to be prefetched
      if (!prefetchLanguages.some((lang) => LanguageUtils.areLanguageCompatible(variant.audio!.language, lang))) {
        continue;
      }

      // use the helper to create a segment prefetch to ensure that existing
      // objects are reused.
      const segmentPrefetch = this.createSegmentPrefetch_(variant.audio);

      // if a segment prefetch wasn't created, skip the rest
      if (!segmentPrefetch) {
        continue;
      }

      if (!variant.audio.segmentIndex) {
        variant.audio.createSegmentIndex();
      }

      this.audioPrefetchMap_.set(variant.audio, segmentPrefetch);
    }
  }

  /**
   * Called when |mediaState|'s update timer has expired.
   */
  private async onUpdate_(mediaState: MediaState) {
    this.destroyer_.ensureNotDestroyed();

    const logPrefix = StreamingEngine.logPrefix_(mediaState);
    asserts.assert(
      !mediaState.performingUpdate && mediaState.updateTimer != null,
      logPrefix + ' unexpected call to onUpdate_()'
    );
    if (mediaState.performingUpdate || mediaState.updateTimer == null) {
      return;
    }
    asserts.assert(
      !mediaState.clearingBuffer,
      logPrefix + ' onUpdate_() should not be called when clearing the buffer'
    );
    if (mediaState.clearingBuffer) {
      return;
    }

    mediaState.updateTimer = null;

    // Handle pending buffer clears.
    if (mediaState.waitingToClearBuffer) {
      // Note: clearBuffer_() will schedule the next update.
      log.debug(logPrefix, 'skipping update and clearing the buffer');
      await this.clearBuffer_(mediaState, mediaState.waitingToFlushBuffer, mediaState.clearBufferSafeMargin);
      return;
    }

    // Make sure the segment index exists. If not, create the segment index.
    if (!mediaState.stream.segmentIndex) {
      const thisStream = mediaState.stream;

      await mediaState.stream.createSegmentIndex();

      if (thisStream != mediaState.stream) {
        // We switched streams while in the middle of this async call to
        // createSegmentIndex.  Abandon this update and schedule a new one if
        // there's not already one pending.
        // Releases the segmentIndex of the old stream.
        if (thisStream.closeSegmentIndex) {
          asserts.assert(!mediaState.stream.segmentIndex, 'mediastate.stream should not have segmentIndex yet.');
          thisStream.closeSegmentIndex();
        }
        if (!mediaState.performingUpdate && !mediaState.updateTimer) {
          this.scheduleUpdate_(mediaState, 0);
        }
        return;
      }
    }

    // Update the MediaState.
    try {
      const delay = this.update_(mediaState);
      if (delay != null) {
        this.scheduleUpdate_(mediaState, delay);
        mediaState.hasError = false;
      }
    } catch (error: any) {
      await this.handleStreamingError_(mediaState, error);
      return;
    }

    const mediaStates = Array.from(this.mediaStates_.values());

    // Check if we've buffered to the end of the presentation.  We delay adding
    // the audio and video media states, so it is possible for the text stream
    // to be the only state and buffer to the end.  So we need to wait until we
    // have completed startup to determine if we have reached the end.
    if (this.startupComplete_ && mediaStates.every((ms) => ms.endOfStream)) {
      log.v1(logPrefix, 'calling endOfStream()...');
      await this.playerInterface_.mediaSourceEngine.endOfStream();
      this.destroyer_.ensureNotDestroyed();

      // If the media segments don't reach the end, then we need to update the
      // timeline duration to match the final media duration to avoid
      // buffering forever at the end.
      // We should only do this if the duration needs to shrink.
      // Growing it by less than 1ms can actually cause buffering on
      // replay, as in https://github.com/shaka-project/shaka-player/issues/979
      // On some platforms, this can spuriously be 0, so ignore this case.
      // https://github.com/shaka-project/shaka-player/issues/1967,
      const duration = this.playerInterface_.mediaSourceEngine.getDuration();
      if (duration != 0 && duration < this.manifest_.presentationTimeline.getDuration()) {
        this.manifest_.presentationTimeline.setDuration(duration);
      }
    }
  }

  /**
   * Updates the given MediaState.
   * @param mediaState
   * @returns The number of seconds to wait until updating again or
   *   null if another update does not need to be scheduled.
   */
  private update_(mediaState: MediaState): number | null {
    asserts.assert(this.manifest_, 'manifest_ should not be null');
    asserts.assert(this.config_, 'config_ should not be null');
    // Do not schedule update for closed captions text mediastate, since closed
    // captions are embedded in video streams.
    // TODO(sanfeng): TextEngine
    // if (shaka.media.StreamingEngine.isEmbeddedText_(mediaState)) {
    //   this.playerInterface_.mediaSourceEngine.setSelectedClosedCaptionId(mediaState.stream.originalId || '');
    //   return null;
    // } lse if (mediaState.type == ContentType.TEXT) {
    // Disable embedded captions if not desired (e.g. if transitioning from
    // embedded to not-embedded captions).
    // this.playerInterface_.mediaSourceEngine.clearSelectedClosedCaptionId();
    // }

    if (!this.playerInterface_.mediaSourceEngine.isStreamingAllowed() && mediaState.type != ContentType.TEXT) {
      // It is not allowed to add segments yet, so we schedule an update to
      // check again later. So any prediction we make now could be terribly
      // invalid soon.
      return this.config_.updateIntervalSeconds / 2;
    }

    const logPrefix = StreamingEngine.logPrefix_(mediaState);

    // Compute how far we've buffered ahead of the playhead.
    const presentationTime = this.playerInterface_.getPresentationTime();

    if (mediaState.type === ContentType.AUDIO) {
      // evict all prefetched segments that are before the presentationTime
      for (const stream of this.audioPrefetchMap_.keys()) {
        const prefetch = this.audioPrefetchMap_.get(stream)!;
        prefetch.evict(presentationTime, /* clearInitSegments= */ true);
        prefetch.prefetchSegmentsByTime(presentationTime);
      }
    }

    // Get the next timestamp we need.
    const timeNeeded = this.getTimeNeeded_(mediaState, presentationTime);
    log.v2(logPrefix, 'timeNeeded=' + timeNeeded);

    // Get the amount of content we have buffered, accounting for drift.  This
    // is only used to determine if we have meet the buffering goal.  This
    // should be the same method that PlayheadObserver uses.
    const bufferedAhead = this.playerInterface_.mediaSourceEngine.bufferedAheadOf(mediaState.type, presentationTime);

    log.v2(logPrefix, 'update_:', 'presentationTime=' + presentationTime, 'bufferedAhead=' + bufferedAhead);

    const unscaledBufferingGoal = Math.max(
      this.manifest_.minBufferTime || 0,
      this.config_.rebufferingGoal,
      this.config_.bufferingGoal
    );
    const scaledBufferingGoal = Math.max(1, unscaledBufferingGoal * this.bufferingGoalScale_);

    // Check if we've buffered to the end of the presentation.
    const timeUntilEnd = this.manifest_.presentationTimeline.getDuration() - timeNeeded;
    const oneMicrosecond = 1e-6;

    const bufferEnd = this.playerInterface_.mediaSourceEngine.bufferEnd(mediaState.type);
    if (timeUntilEnd < oneMicrosecond && !!bufferEnd) {
      // We shouldn't rebuffer if the playhead is close to the end of the
      // presentation.
      log.debug(logPrefix, 'buffered to end of presentation');
      mediaState.endOfStream = true;

      if (mediaState.type == ContentType.VIDEO) {
        // Since the text stream of CEA closed captions doesn't have update
        // timer, we have to set the text endOfStream based on the video
        // stream's endOfStream state.
        // TODO(sanfeng): TextEngine
        // const textState = this.mediaStates_.get(ContentType.TEXT);
        // if (textState && treamingEngine.isEmbeddedText_(textState)) {
        //   textState.endOfStream = true;
        // }
      }
      return null;
    }

    // If we've buffered to the buffering goal then schedule an update.
    if (bufferedAhead >= scaledBufferingGoal) {
      log.v2(logPrefix, 'buffering goal met');

      // Do not try to predict the next update.  Just poll according to
      // configuration (seconds). The playback rate can change at any time, so
      // any prediction we make now could be terribly invalid soon.
      return this.config_.updateIntervalSeconds / 2;
    }

    const reference = this.getSegmentReferenceNeeded_(mediaState, presentationTime, bufferEnd);
    if (!reference) {
      // The segment could not be found, does not exist, or is not available.
      // In any case just try again... if the manifest is incomplete or is not
      // being updated then we'll idle forever; otherwise, we'll end up getting
      // a SegmentReference eventually.
      return this.config_.updateIntervalSeconds;
    }

    // Do not let any one stream get far ahead of any other.
    let minTimeNeeded = Infinity;
    const mediaStates = Array.from(this.mediaStates_.values());
    for (const otherState of mediaStates) {
      // Do not consider embedded captions in this calculation.  It could lead
      // to hangs in streaming.
      // TODO(sanfeng): TextEngine
      // if (shaka.media.StreamingEngine.isEmbeddedText_(otherState)) {
      //   continue;
      // }
      // If there is no next segment, ignore this stream.  This happens with
      // text when there's a Period with no text in it.
      if (otherState.segmentIterator && !otherState.segmentIterator.current()) {
        continue;
      }

      const timeNeeded = this.getTimeNeeded_(otherState, presentationTime);
      minTimeNeeded = Math.min(minTimeNeeded, timeNeeded);
    }

    const maxSegmentDuration = this.manifest_.presentationTimeline.getMaxSegmentDuration();
    const maxRunAhead = maxSegmentDuration * StreamingEngine.MAX_RUN_AHEAD_SEGMENTS_;
    if (timeNeeded >= minTimeNeeded + maxRunAhead) {
      // Wait and give other media types time to catch up to this one.
      // For example, let video buffering catch up to audio buffering before
      // fetching another audio segment.
      // 等待其他流追赶到这个流
      log.v2(logPrefix, 'waiting for other streams to buffer');
      return this.config_.updateIntervalSeconds;
    }

    if (mediaState.segmentPrefetch && mediaState.segmentIterator && !this.audioPrefetchMap_.has(mediaState.stream)) {
      mediaState.segmentPrefetch.evict(presentationTime);
      mediaState.segmentPrefetch.prefetchSegmentsByTime(reference.startTime);
    }

    const p = this.fetchAndAppend_(mediaState, presentationTime, reference);
    p.catch(() => {}); // TODO(#1993): Handle asynchronous errors.
    return null;
  }

  /**
   *  Gets the SegmentReference of the next segment needed.
   * @param mediaState
   * @param presentationTime
   * @param bufferEnd
   * @returns  The SegmentReference of the
   *   next segment needed. Returns null if a segment could not be found, does
   *   not exist, or is not available.
   */
  private getSegmentReferenceNeeded_(mediaState: MediaState, presentationTime: number, bufferEnd: number | null) {
    const logPrefix = StreamingEngine.logPrefix_(mediaState);
    asserts.assert(mediaState.stream.segmentIndex, 'segment index should have been generated already');

    if (mediaState.segmentIterator) {
      // Something is buffered from the same Stream.  Use the current position
      // in the segment index.  This is updated via next() after each segment is
      // appended.
      return mediaState.segmentIterator.current();
    } else if (mediaState.lastSegmentReference || bufferEnd) {
      // Something is buffered from another Stream.
      const time = mediaState.lastSegmentReference ? mediaState.lastSegmentReference.endTime : bufferEnd;
      asserts.assert(time !== null, 'Should have a time to search');
      log.v1(logPrefix, 'looking up segment from new stream endTime:', time);

      const reverse = this.playerInterface_.getPlaybackRate() < 0;
      mediaState.segmentIterator = mediaState.stream.segmentIndex!.getIteratorForTime(
        time!,
        /* allowNonIndepedent= */ false,
        reverse
      );
      const ref = mediaState.segmentIterator && mediaState.segmentIterator.next().value;
      if (ref == null) {
        log.warning(logPrefix, 'cannot find segment', 'endTime:', time);
      }
      return ref;
    } else {
      // Nothing is buffered.  Start at the playhead time.

      // If there's positive drift then we need to adjust the lookup time, and
      // may wind up requesting the previous segment to be safe.
      // inaccurateManifestTolerance should be 0 for low latency streaming.
      const inaccurateTolerance = this.config_.inaccurateManifestTolerance;
      const lookupTime = Math.max(presentationTime - inaccurateTolerance, 0);

      log.v1(logPrefix, 'looking up segment', 'lookupTime:', lookupTime, 'presentationTime:', presentationTime);

      const reverse = this.playerInterface_.getPlaybackRate() < 0;
      let ref = null;
      if (inaccurateTolerance) {
        mediaState.segmentIterator = mediaState.stream.segmentIndex!.getIteratorForTime(
          lookupTime,
          /* allowNonIndepedent= */ false,
          reverse
        );
        ref = mediaState.segmentIterator && mediaState.segmentIterator.next().value;
      }
      if (!ref) {
        // If we can't find a valid segment with the drifted time, look for a
        // segment with the presentation time.
        mediaState.segmentIterator = mediaState.stream.segmentIndex!.getIteratorForTime(
          presentationTime,
          /* allowNonIndepedent= */ false,
          reverse
        );
        ref = mediaState.segmentIterator && mediaState.segmentIterator.next().value;
      }
      if (ref == null) {
        log.warning(logPrefix, 'cannot find segment', 'lookupTime:', lookupTime, 'presentationTime:', presentationTime);
      }
      return ref;
    }
  }

  /**
   * Fetches and appends the given segment. Sets up the given MediaState's
   * associated SourceBuffer and evicts segments if either are required
   * beforehand. Schedules another update after completing successfully.
   */
  async fetchAndAppend_(mediaState: MediaState, presentationTime: number, reference: SegmentReference) {
    const logPrefix = StreamingEngine.logPrefix_(mediaState);

    log.v1(
      logPrefix,
      'fetchAndAppend_:',
      'presentationTime=' + presentationTime,
      'reference.startTime=' + reference.startTime,
      'reference.endTime=' + reference.endTime
    );

    // Subtlety: The playhead may move while asynchronous update operations are
    // in progress, so we should avoid calling playhead.getTime() in any
    // callbacks. Furthermore, switch() or seeked() may be called at any time,
    // so we store the old iterator.  This allows the mediaState to change and
    // we'll update the old iterator.
    const stream = mediaState.stream;
    const iter = mediaState.segmentIterator;

    mediaState.performingUpdate = true;

    try {
      if (reference.getStatus() === SegmentReferenceStatus.MISSING) {
        throw new ShakaError(
          ShakaError.Severity.RECOVERABLE,
          ShakaError.Category.NETWORK,
          ShakaError.Code.SEGMENT_MISSING
        );
      }

      await this.initSourceBuffer_(mediaState, reference);
      this.destroyer_.ensureNotDestroyed();
      if (this.fatalError_) {
        return;
      }

      log.v2(logPrefix, 'fetching segment');
      const isMP4 = stream.mimeType == 'video/mp4' || stream.mimeType == 'audio/mp4';
      const isReadableStreamSupported = window.ReadableStream;
      // Enable MP4 low latency streaming with ReadableStream chunked data.
      // And only for DASH and HLS with byterange optimization.
      if (
        this.config_.lowLatencyMode &&
        isReadableStreamSupported &&
        isMP4 &&
        (this.manifest_.type != ManifestParser.HLS || reference.hasByterangeOptimization())
      ) {
        let remaining = new Uint8Array(0);
        let processingResult = false;
        let callbackCalled = false;
        let streamDataCallbackError;
        const streamDataCallback = async (data: BufferSource) => {
          if (processingResult) {
            // If the fallback result processing was triggered, don't also
            // append the buffer here.  In theory this should never happen,
            // but it does on some older TVs.
            return;
          }
          callbackCalled = true;
          this.destroyer_.ensureNotDestroyed();
          if (this.fatalError_) {
            return;
          }
          try {
            // Append the data with complete boxes.
            // Every time streamDataCallback gets called, append the new data
            // to the remaining data.
            // Find the last fully completed Mdat box, and slice the data into
            // two parts: the first part with completed Mdat boxes, and the
            // second part with an incomplete box.
            // Append the first part, and save the second part as remaining
            // data, and handle it with the next streamDataCallback call.
            remaining = this.concatArray_(remaining, data as Uint8Array);
            let sawMDAT = false;
            let offset = 0;
            new Mp4Parser()
              .box('mdat', (box) => {
                offset = box.size + box.start;
                sawMDAT = true;
              })
              .parse(remaining, /* partialOkay= */ false, /* isChunkedData= */ true);
            if (sawMDAT) {
              const dataToAppend = remaining.subarray(0, offset);
              remaining = remaining.subarray(offset);
              await this.append_(
                mediaState,
                presentationTime,
                stream,
                reference,
                dataToAppend,
                /* isChunkedData= */ true
              );

              if (mediaState.segmentPrefetch && mediaState.segmentIterator) {
                mediaState.segmentPrefetch.prefetchSegmentsByTime(reference.startTime, /* skipFirst= */ true);
              }
            }
          } catch (error) {
            streamDataCallbackError = error;
          }
        };

        const result = await this.fetch_(mediaState, reference, streamDataCallback);
        if (streamDataCallbackError) {
          throw streamDataCallbackError;
        }
        if (!callbackCalled) {
          // In some environments, we might be forced to use network plugins
          // that don't support streamDataCallback. In those cases, as a
          // fallback, append the buffer here.
          processingResult = true;
          this.destroyer_.ensureNotDestroyed();
          if (this.fatalError_) {
            return;
          }

          // If the text stream gets switched between fetch_() and append_(),
          // the new text parser is initialized, but the new init segment is
          // not fetched yet.  That would cause an error in
          // TextParser.parseMedia().
          // See http://b/168253400
          if (mediaState.waitingToClearBuffer) {
            log.info(logPrefix, 'waitingToClearBuffer, skip append');
            mediaState.performingUpdate = false;
            this.scheduleUpdate_(mediaState, 0);
            return;
          }

          await this.append_(mediaState, presentationTime, stream, reference, result);
        }

        if (mediaState.segmentPrefetch && mediaState.segmentIterator) {
          mediaState.segmentPrefetch.prefetchSegmentsByTime(reference.startTime, /* skipFirst= */ true);
        }
      } else {
        if (this.config_.lowLatencyMode && !isReadableStreamSupported) {
          log.warning(
            'Low latency streaming mode is enabled, but ' + 'ReadableStream is not supported by the browser.'
          );
        }
        const fetchSegment = this.fetch_(mediaState, reference);
        const result = await fetchSegment;
        this.destroyer_.ensureNotDestroyed();
        if (this.fatalError_) {
          return;
        }
        this.destroyer_.ensureNotDestroyed();

        // If the text stream gets switched between fetch_() and append_(), the
        // new text parser is initialized, but the new init segment is not
        // fetched yet.  That would cause an error in TextParser.parseMedia().
        // See http://b/168253400
        if (mediaState.waitingToClearBuffer) {
          log.info(logPrefix, 'waitingToClearBuffer, skip append');
          mediaState.performingUpdate = false;
          this.scheduleUpdate_(mediaState, 0);
          return;
        }

        await this.append_(mediaState, presentationTime, stream, reference, result);
      }
      this.destroyer_.ensureNotDestroyed();
      if (this.fatalError_) {
        return;
      }
      // move to next segment after appending the current segment.
      mediaState.lastSegmentReference = reference;
      const newRef = iter!.next().value;
      log.v2(logPrefix, 'advancing to next segment', newRef);

      mediaState.performingUpdate = false;
      mediaState.recovering = false;

      const info = this.playerInterface_.mediaSourceEngine.getBufferedInfo();
      // @ts-expect-error
      const buffered = info[mediaState.type];

      // Convert the buffered object to a string capture its properties on
      // WebOS.
      log.v1(logPrefix, 'finished fetch and append', JSON.stringify(buffered));
      if (!mediaState.waitingToClearBuffer) {
        this.playerInterface_.onSegmentAppended(reference, mediaState.stream);
      }

      // Update right away.
      this.scheduleUpdate_(mediaState, 0);
    } catch (error: any) {
      this.destroyer_.ensureNotDestroyed(error);
      if (this.fatalError_) {
        return;
      }
      asserts.assert(error instanceof ShakaError, 'Should only receive a Shaka error');
      if (error.code == ShakaError.Code.OPERATION_ABORTED) {
        // If the network slows down, abort the current fetch request and start
        // a new one, and ignore the error message.
        mediaState.performingUpdate = false;
        this.cancelUpdate_(mediaState);
        this.scheduleUpdate_(mediaState, 0);
      } else if (mediaState.type == ContentType.TEXT && this.config_.ignoreTextStreamFailures) {
        if (error.code == ShakaError.Code.BAD_HTTP_STATUS) {
          log.warning(logPrefix, 'Text stream failed to download. Proceeding without it.');
        } else {
          log.warning(logPrefix, 'Text stream failed to parse. Proceeding without it.');
        }
        this.mediaStates_.delete(ContentType.TEXT);
      } else if (error.code === ShakaError.Code.QUOTA_EXCEEDED_ERROR) {
        this.handleQuotaExceeded_(mediaState, error);
      } else {
        log.error(logPrefix, 'failed fetch and append: code=' + error.code);
        mediaState.hasError = true;

        if (error.category == ShakaError.Category.NETWORK && mediaState.segmentPrefetch) {
          mediaState.segmentPrefetch.removeReference(reference);
        }

        error.severity = ShakaError.Severity.CRITICAL;
        await this.handleStreamingError_(mediaState, error);
      }
    }
  }
  /**
   * Clear per-stream error states and retry any failed streams.
   */
  retry(delaySeconds: number) {
    if (this.destroyer_.destroyed()) {
      log.error('Unable to retry after StreamingEngine is destroyed!');
      return false;
    }

    if (this.fatalError_) {
      log.error('Unable to retry after StreamingEngine encountered a ' + 'fatal error!');
      return false;
    }

    for (const mediaState of this.mediaStates_.values()) {
      const logPrefix = StreamingEngine.logPrefix_(mediaState);

      if (mediaState.hasError && !mediaState.performingUpdate && !mediaState.updateTimer) {
        log.info(logPrefix, 'Retrying after failure....');
        mediaState.hasError = false;
        this.scheduleUpdate_(mediaState, delaySeconds);
      }
    }
    return true;
  }

  private concatArray_(remaining: Uint8Array, data: Uint8Array) {
    const result = new Uint8Array(remaining.length + data.length);
    result.set(remaining);
    result.set(data, remaining.length);
    return result;
  }

  private handleQuotaExceeded_(mediaState: MediaState, error: ShakaError) {
    const logPrefix = StreamingEngine.logPrefix_(mediaState);

    // The segment cannot fit into the SourceBuffer. Ideally, MediaSource would
    // have evicted old data to accommodate the segment; however, it may have
    // failed to do this if the segment is very large, or if it could not find
    // a suitable time range to remove.
    //
    // We can overcome the latter by trying to append the segment again;
    // however, to avoid continuous QuotaExceededErrors we must reduce the size
    // of the buffer going forward.
    //
    // If we've recently reduced the buffering goals, wait until the stream
    // which caused the first QuotaExceededError recovers. Doing this ensures
    // we don't reduce the buffering goals too quickly.

    const mediaStates = Array.from(this.mediaStates_.values());

    const waitingForAnotherStreamToRecover = mediaStates.some((ms) => {
      return ms !== mediaState && ms.recovering;
    });

    if (!waitingForAnotherStreamToRecover) {
      if (this.config_.maxDisabledTime > 0) {
        const handle = this.playerInterface_.disableStream(mediaState.stream, this.config_.maxDisabledTime);
        if (handle) {
          return;
        }
      }

      // Reduction schedule: 80%, 60%, 40%, 20%, 16%, 12%, 8%, 4%, fail.
      // Note: percentages are used for comparisons to avoid rounding errors.
      const percentBefore = Math.round(100 * this.bufferingGoalScale_);
      if (percentBefore > 20) {
        this.bufferingGoalScale_ -= 0.2;
      } else if (percentBefore > 4) {
        this.bufferingGoalScale_ -= 0.04;
      } else {
        log.error(logPrefix, 'MediaSource threw QuotaExceededError too many times');
        mediaState.hasError = true;
        this.fatalError_ = true;
        this.playerInterface_.onError(error);
        return;
      }

      const percentAfter = Math.round(100 * this.bufferingGoalScale_);
      log.warning(
        logPrefix,
        'MediaSource threw QuotaExceededError:',
        'reducing buffering goals by ' + (100 - percentAfter) + '%'
      );
      mediaState.recovering = true;
    } else {
      log.debug(logPrefix, 'MediaSource threw QuotaExceededError:', 'waiting for another stream to recover...');
    }

    // QuotaExceededError gets thrown if eviction didn't help to make room
    // for a segment. We want to wait for a while (4 seconds is just an
    // arbitrary number) before updating to give the playhead a chance to
    // advance, so we don't immediately throw again.
    this.scheduleUpdate_(mediaState, 4);
  }

  /**
   * Sets the given MediaState's associated SourceBuffer's timestamp offset,
   * append window, and init segment if they have changed. If an error occurs
   * then neither the timestamp offset or init segment are unset, since another
   * call to switch() will end up superseding them.
   * @param mediaState
   * @param reference
   */
  private async initSourceBuffer_(mediaState: MediaState, reference: SegmentReference) {
    const logPrefix = StreamingEngine.logPrefix_(mediaState);
    const operations: Promise<void>[] = [];
    // Rounding issues can cause us to remove the first frame of a Period, so
    // reduce the window start time slightly.
    const appendWindowStart = Math.max(0, reference.appendWindowStart - StreamingEngine.APPEND_WINDOW_START_FUDGE_);

    const appendWindowEnd = reference.appendWindowEnd + StreamingEngine.APPEND_WINDOW_END_FUDGE_;
    asserts.assert(
      reference.startTime <= appendWindowEnd,
      logPrefix + ' segment should start before append window end'
    );

    const codecs = MimeUtils.getCodecBase(mediaState.stream.codecs);
    const mimeType = MimeUtils.getBasicType(mediaState.stream.mimeType);
    const timestampOffset = reference.timestampOffset;

    if (
      timestampOffset !== mediaState.lastTimestampOffset ||
      appendWindowStart !== mediaState.lastAppendWindowStart ||
      appendWindowEnd !== mediaState.lastAppendWindowEnd ||
      codecs !== mediaState.lastCodecs ||
      mimeType !== mediaState.lastMimeType
    ) {
      log.v1(logPrefix, 'setting timestamp offset to ' + timestampOffset);
      log.v1(logPrefix, 'setting append window start to ' + appendWindowStart);
      log.v1(logPrefix, 'setting append window end to ' + appendWindowEnd);
      const isResetMediaSourceNecessary =
        mediaState.lastCodecs &&
        mediaState.lastMimeType &&
        this.playerInterface_.mediaSourceEngine.isResetMediaSourceNecessary(
          mediaState.type,
          mediaState.stream,
          mimeType,
          codecs
        );
      if (isResetMediaSourceNecessary) {
        let otherState: MediaState | undefined;
        if (mediaState.type === ContentType.VIDEO) {
          otherState = this.mediaStates_.get(ContentType.AUDIO);
        } else if (mediaState.type === ContentType.AUDIO) {
          otherState = this.mediaStates_.get(ContentType.VIDEO);
        }
        if (otherState) {
          // First, abort all operations in progress on the other stream.
          await this.abortOperations_(otherState).catch(() => {});
          // Then clear our cache of the last init segment, since MSE will be
          // reloaded and no init segment will be there post-reload.
          otherState.lastInitSegmentReference = null;
          // Now force the existing buffer to be cleared.  It is not necessary
          // to perform the MSE clear operation, but this has the side-effect
          // that our state for that stream will then match MSE's post-reload
          // state.
          this.forceClearBuffer_(otherState);
        }
      }
      const setProperties = async () => {
        const streamsByType = new Map<string, Stream>();
        if (this.currentVariant_!.audio) {
          streamsByType.set(ContentType.AUDIO, this.currentVariant_!.audio);
        }
        if (this.currentVariant_!.video) {
          streamsByType.set(ContentType.VIDEO, this.currentVariant_!.video);
        }
        try {
          mediaState.lastAppendWindowStart = appendWindowStart;
          mediaState.lastAppendWindowEnd = appendWindowEnd;
          mediaState.lastCodecs = codecs;
          mediaState.lastMimeType = mimeType;
          mediaState.lastTimestampOffset = timestampOffset;

          const ignoreTimestampOffset = this.manifest_.sequenceMode || this.manifest_.type == ManifestParser.HLS;

          await this.playerInterface_.mediaSourceEngine.setStreamProperties(
            mediaState.type,
            timestampOffset,
            appendWindowStart,
            appendWindowEnd,
            ignoreTimestampOffset,
            reference.mimeType || mediaState.stream.mimeType,
            reference.codecs || mediaState.stream.codecs,
            streamsByType
          );
        } catch (error) {
          mediaState.lastAppendWindowStart = null;
          mediaState.lastAppendWindowEnd = null;
          mediaState.lastCodecs = null;
          mediaState.lastTimestampOffset = null;

          throw error;
        }
      };
      // Dispatching init asynchronously causes the sourceBuffers in
      // the MediaSourceEngine to become detached do to race conditions
      // with mediaSource and sourceBuffers being created simultaneously.
      await setProperties();
    }

    if (!InitSegmentReference.equal(reference.initSegmentReference, mediaState.lastInitSegmentReference)) {
      mediaState.lastInitSegmentReference = reference.initSegmentReference;
      if (reference.isIndependent() && reference.initSegmentReference) {
        log.v1(logPrefix, 'fetching init segment');

        const fetchInit = this.fetch_(mediaState, reference.initSegmentReference);

        const append = async () => {
          try {
            const initSegment = await fetchInit;
            this.destroyer_.ensureNotDestroyed();

            let lastTimescale: number | null;
            const timescaleMap = new Map();

            const spatialVideoInfo: SpatialVideoInfo = {
              projection: null,
              hfov: null,
            };

            const parser = new Mp4Parser();

            parser
              .box('moov', Mp4Parser.children)
              .box('trak', Mp4Parser.children)
              .box('mdia', Mp4Parser.children)
              .fullBox('mdhd', (box) => {
                asserts.assert(box.version !== null, 'MDHD is a full box and should have a valid version.');
                const parsedMDHDBox = Mp4BoxParsers.parseMDHD(box.reader, box.version!);
                lastTimescale = parsedMDHDBox.timescale;
              })
              .box('hdlr', (box) => {
                const parsedHDLR = Mp4BoxParsers.parseHDLR(box.reader);
                switch (parsedHDLR.handlerType) {
                  case 'soun':
                    timescaleMap.set(ContentType.AUDIO, lastTimescale);
                    break;
                  case 'vide':
                    timescaleMap.set(ContentType.VIDEO, lastTimescale);
                    break;
                }
                lastTimescale = null;
              })
              .box('minf', Mp4Parser.children)
              .box('stbl', Mp4Parser.children)
              .fullBox('stsd', Mp4Parser.sampleDescription)
              .box('encv', Mp4Parser.visualSampleEntry)
              .box('avc1', Mp4Parser.visualSampleEntry)
              .box('avc3', Mp4Parser.visualSampleEntry)
              .box('hev1', Mp4Parser.visualSampleEntry)
              .box('hvc1', Mp4Parser.visualSampleEntry)
              .box('dvav', Mp4Parser.visualSampleEntry)
              .box('dva1', Mp4Parser.visualSampleEntry)
              .box('dvh1', Mp4Parser.visualSampleEntry)
              .box('dvhe', Mp4Parser.visualSampleEntry)
              .box('vexu', Mp4Parser.children)
              .box('proj', Mp4Parser.children)
              .fullBox('prji', (box) => {
                const parsedPRJIBox = Mp4BoxParsers.parsePRJI(box.reader);
                spatialVideoInfo.projection = parsedPRJIBox.projection;
              })
              .box('hfov', (box) => {
                const parsedHFOVBox = Mp4BoxParsers.parseHFOV(box.reader);
                spatialVideoInfo.hfov = parsedHFOVBox.hfov;
              })
              .parse(initSegment);

            this.updateSpatialVideoInfo_(spatialVideoInfo);

            log.v1(logPrefix, 'appending init segment');
            const hasClosedCaptions = mediaState.stream.closedCaptions && mediaState.stream.closedCaptions.size > 0;
            await this.playerInterface_.beforeAppendSegment(mediaState.type, initSegment);
            await this.playerInterface_.mediaSourceEngine.appendBuffer(
              mediaState.type,
              initSegment,
              /* reference= */ null,
              mediaState.stream,
              hasClosedCaptions
            );
          } catch (error) {
            console.log(error);
          }
        };

        this.playerInterface_.onInitSegmentAppended(reference.startTime, reference.initSegmentReference);
        operations.push(append());
      }
    }

    if (this.manifest_.sequenceMode) {
      const lastDiscontinuitySequence = mediaState.lastSegmentReference
        ? mediaState.lastSegmentReference.discontinuitySequence
        : null;
      // Across discontinuity bounds, we should resync timestamps for
      // sequence mode playbacks.  The next segment appended should
      // land at its theoretical timestamp from the segment index.
      if (reference.discontinuitySequence != lastDiscontinuitySequence) {
        operations.push(this.playerInterface_.mediaSourceEngine.resync(mediaState.type, reference.startTime));
      }
    }

    await Promise.all(operations);
  }

  /**
   * Appends the given segment and evicts content if required to append.
   * @param mediaState
   * @param presentationTime
   * @param stream
   * @param reference
   * @param segment
   * @param isChunkedData
   */
  async append_(
    mediaState: MediaState,
    presentationTime: number,
    stream: Stream,
    reference: SegmentReference,
    segment: BufferSource,
    isChunkedData = false
  ) {
    const logPrefix = StreamingEngine.logPrefix_(mediaState);

    const hasClosedCaptions = stream.closedCaptions && stream.closedCaptions.size > 0;

    let parser: Mp4Parser;
    const hasEmsg =
      (stream.emsgSchemeIdUris && stream.emsgSchemeIdUris.length > 0) || this.config_.dispatchAllEmsgBoxes;
    const shouldParsePrftBox = this.config_.parsePrftBox && !this.parsedPrftEventRaised_;

    if (hasEmsg || shouldParsePrftBox) {
      parser = new Mp4Parser();
    }

    if (hasEmsg) {
      parser!.fullBox('emsg', (box) => this.parseEMSG_(reference, stream.emsgSchemeIdUris!, box));
    }

    if (shouldParsePrftBox) {
      parser!.fullBox('prft', (box) => this.parsePrft_(reference, box));
    }

    if (hasEmsg || shouldParsePrftBox) {
      parser!.parse(segment);
    }

    await this.evict_(mediaState, presentationTime);
    this.destroyer_.ensureNotDestroyed();

    // 'seeked' or 'adaptation' triggered logic applies only to this
    // appendBuffer() call.
    const seeked = mediaState.seeked;
    mediaState.seeked = false;
    const adaptation = mediaState.adaptation;
    mediaState.adaptation = false;

    await this.playerInterface_.beforeAppendSegment(mediaState.type, segment);
    await this.playerInterface_.mediaSourceEngine.appendBuffer(
      mediaState.type,
      segment,
      reference,
      stream,
      hasClosedCaptions,
      seeked,
      adaptation,
      isChunkedData
    );
    this.destroyer_.ensureNotDestroyed();
    log.v2(logPrefix, 'appended media segment');
  }

  /**
   * Parse the EMSG box from a MP4 container.
   *
   * @param  reference
   * @param emsgSchemeIdUris Array of emsg
   *     scheme_id_uri for which emsg boxes should be parsed.
   * @param box
   * @private
   * https://dashif-documents.azurewebsites.net/Events/master/event.html#emsg-format
   * aligned(8) class DASHEventMessageBox
   *    extends FullBox(‘emsg’, version, flags = 0){
   * if (version==0) {
   *   string scheme_id_uri;
   *   string value;
   *   unsigned int(32) timescale;
   *   unsigned int(32) presentation_time_delta;
   *   unsigned int(32) event_duration;
   *   unsigned int(32) id;
   * } else if (version==1) {
   *   unsigned int(32) timescale;
   *   unsigned int(64) presentation_time;
   *   unsigned int(32) event_duration;
   *   unsigned int(32) id;
   *   string scheme_id_uri;
   *   string value;
   * }
   * unsigned int(8) message_data[];
   */
  private parseEMSG_(reference: SegmentReference, emsgSchemeIdUris: string[] | null, box: ParsedBox) {
    let timescale;
    let id;
    let eventDuration;
    let schemeId;
    let startTime;
    let presentationTimeDelta;
    let value;

    if (box.version === 0) {
      schemeId = box.reader.readTerminatedString();
      value = box.reader.readTerminatedString();
      timescale = box.reader.readUint32();
      presentationTimeDelta = box.reader.readUint32();
      eventDuration = box.reader.readUint32();
      id = box.reader.readUint32();
      startTime = reference.startTime + presentationTimeDelta / timescale;
    } else {
      timescale = box.reader.readUint32();
      const pts = box.reader.readUint64();
      startTime = pts / timescale + reference.timestampOffset;
      presentationTimeDelta = startTime - reference.startTime;
      eventDuration = box.reader.readUint32();
      id = box.reader.readUint32();
      schemeId = box.reader.readTerminatedString();
      value = box.reader.readTerminatedString();
    }
    const messageData = box.reader.readBytes(box.reader.getLength() - box.reader.getPosition());

    // See DASH sec. 5.10.3.3.1
    // If a DASH client detects an event message box with a scheme that is not
    // defined in MPD, the client is expected to ignore it.
    if ((emsgSchemeIdUris && emsgSchemeIdUris.includes(schemeId)) || this.config_.dispatchAllEmsgBoxes) {
      // See DASH sec. 5.10.4.1
      // A special scheme in DASH used to signal manifest updates.
      if (schemeId == 'urn:mpeg:dash:event:2012') {
        this.playerInterface_.onManifestUpdate();
      } else {
        // All other schemes are dispatched as a general 'emsg' event.
        /** @type {shaka.extern.EmsgInfo} */
        const emsg = {
          startTime: startTime,
          endTime: startTime + eventDuration / timescale,
          schemeIdUri: schemeId,
          value: value,
          timescale: timescale,
          presentationTimeDelta: presentationTimeDelta,
          eventDuration: eventDuration,
          id: id,
          messageData: messageData,
        };

        // Dispatch an event to notify the application about the emsg box.
        const eventName = FakeEvent.EventName.Emsg;
        const data = new Map().set('detail', emsg);
        const event = new FakeEvent(eventName, data);
        // A user can call preventDefault() on a cancelable event.
        event.cancelable = true;

        this.playerInterface_.onEvent(event);

        if (event.defaultPrevented) {
          // If the caller uses preventDefault() on the 'emsg' event, don't
          // process any further, and don't generate an ID3 'metadata' event
          // for the same data.
          return;
        }

        // Additionally, ID3 events generate a 'metadata' event.  This is a
        // pre-parsed version of the metadata blob already dispatched in the
        // 'emsg' event.
        if (
          schemeId == 'https://aomedia.org/emsg/ID3' ||
          schemeId == 'https://developer.apple.com/streaming/emsg-id3'
        ) {
          // See https://aomediacodec.github.io/id3-emsg/
          const frames = Id3Utils.getID3Frames(messageData);
          if (frames.length && reference) {
            /** @private {shaka.extern.ID3Metadata} */
            const metadata = {
              cueTime: reference.startTime,
              data: messageData,
              frames: frames,
              dts: reference.startTime,
              pts: reference.startTime,
            };
            this.playerInterface_.onMetadata([metadata], /* offset= */ 0, reference.endTime);
          }
        }
      }
    }
  }

  /**
   * Parse PRFT box.
   * @param {!shaka.media.SegmentReference} reference
   * @param {!shaka.extern.ParsedBox} box
   * @private
   */
  parsePrft_(reference: SegmentReference, box: ParsedBox) {
    if (this.parsedPrftEventRaised_ || !reference.initSegmentReference!.timescale) {
      return;
    }
    asserts.assert(box.version == 0 || box.version == 1, 'PRFT version can only be 0 or 1');
    const parsed = Mp4BoxParsers.parsePRFTInaccurate(box.reader, box.version!);

    const timescale = reference.initSegmentReference!.timescale;
    const wallClockTime = this.convertNtp(parsed.ntpTimestamp);
    const programStartDate = new Date(wallClockTime - (parsed.mediaTime / timescale) * 1000);
    const prftInfo = {
      wallClockTime,
      programStartDate,
    };

    const eventName = FakeEvent.EventName.Prft;
    const data = new Map().set('detail', prftInfo);
    const event = new FakeEvent(eventName, data);
    this.playerInterface_.onEvent(event);
    this.parsedPrftEventRaised_ = true;
  }

  /**
   * Convert Ntp ntpTimeStamp to UTC Time
   *
   * @param ntpTimeStamp
   * @return utcTime
   */
  convertNtp(ntpTimeStamp: number) {
    const start = new Date(Date.UTC(1900, 0, 1, 0, 0, 0));
    return new Date(start.getTime() + ntpTimeStamp).getTime();
  }

  /**
   * Evicts media to meet the max buffer behind limit.
   *
   * @param mediaState
   * @param  presentationTime
   */
  private async evict_(mediaState: MediaState, presentationTime: number) {
    const logPrefix = StreamingEngine.logPrefix_(mediaState);
    log.v2(logPrefix, 'checking buffer length');

    // Use the max segment duration, if it is longer than the bufferBehind, to
    // avoid accidentally clearing too much data when dealing with a manifest
    // with a long keyframe interval.
    const bufferBehind = Math.max(
      this.config_.bufferBehind,
      this.manifest_.presentationTimeline.getMaxSegmentDuration()
    );

    const startTime = this.playerInterface_.mediaSourceEngine.bufferStart(mediaState.type);
    if (startTime == null) {
      log.v2(
        logPrefix,
        'buffer behind okay because nothing buffered:',
        'presentationTime=' + presentationTime,
        'bufferBehind=' + bufferBehind
      );
      return;
    }
    const bufferedBehind = presentationTime - startTime;

    const overflow = bufferedBehind - bufferBehind;
    // See: https://github.com/shaka-project/shaka-player/issues/6240
    if (overflow <= this.config_.evictionGoal) {
      log.v2(
        logPrefix,
        'buffer behind okay:',
        'presentationTime=' + presentationTime,
        'bufferedBehind=' + bufferedBehind,
        'bufferBehind=' + bufferBehind,
        'evictionGoal=' + this.config_.evictionGoal,
        'underflow=' + Math.abs(overflow)
      );
      return;
    }

    log.v1(
      logPrefix,
      'buffer behind too large:',
      'presentationTime=' + presentationTime,
      'bufferedBehind=' + bufferedBehind,
      'bufferBehind=' + bufferBehind,
      'evictionGoal=' + this.config_.evictionGoal,
      'overflow=' + overflow
    );

    await this.playerInterface_.mediaSourceEngine.remove(mediaState.type, startTime, startTime + overflow);

    this.destroyer_.ensureNotDestroyed();
    log.v1(logPrefix, 'evicted ' + overflow + ' seconds');
  }

  private static isEmbeddedText_(mediaState: MediaState) {
    const CEA608_MIME = MimeUtils.CEA608_CLOSED_CAPTION_MIMETYPE;
    const CEA708_MIME = MimeUtils.CEA708_CLOSED_CAPTION_MIMETYPE;
    return (
      mediaState &&
      mediaState.type == ManifestParserUtils.ContentType.TEXT &&
      (mediaState.stream.mimeType == CEA608_MIME || mediaState.stream.mimeType == CEA708_MIME)
    );
  }

  /**
   * Fetches the given segment.
   * @param mediaState
   * @param reference
   * @param streamDataCallback
   */
  private async fetch_(
    mediaState: MediaState,
    reference: SegmentReference | InitSegmentReference,
    streamDataCallback: StreamDataCallback | null = null
  ): Promise<BufferSource> {
    const segmentData = reference.getSegmentData();
    if (segmentData) {
      return segmentData;
    }
    let op = null;
    if (mediaState.segmentPrefetch) {
      op = mediaState.segmentPrefetch.getPrefetchedSegment(reference, streamDataCallback);
    }
    if (!op) {
      op = this.dispatchFetch_(reference, mediaState.stream, streamDataCallback);
    }

    let position = 0;
    if (mediaState.segmentIterator) {
      position = mediaState.segmentIterator.currentPosition();
    }

    mediaState.operation = op;
    const response = await op.promise;
    mediaState.operation = null;
    let result = response.data;
    if (reference.aesKey) {
      result = await this.aesDecrypt_(result, reference.aesKey, position);
    }
    return result;
  }

  async aesDecrypt_(rawResult: BufferSource, aesKey: AesKey, position: number) {
    const key = aesKey;
    if (!key.cryptoKey) {
      asserts.assert(key.fetchKey, 'If AES cryptoKey was not ' + 'preloaded, fetchKey function should be provided');
      await key.fetchKey!();
      asserts.assert(key.cryptoKey, 'AES cryptoKey should now be set');
    }
    let iv = key.iv;
    if (!iv) {
      iv = BufferUtils.toUint8(new ArrayBuffer(16));
      let sequence = key.firstMediaSequenceNumber + position;
      for (let i = iv.byteLength - 1; i >= 0; i--) {
        iv[i] = sequence & 0xff;
        sequence >>= 8;
      }
    }
    let algorithm;
    if (aesKey.blockCipherMode == 'CBC') {
      algorithm = {
        name: 'AES-CBC',
        iv,
      };
    } else {
      algorithm = {
        name: 'AES-CTR',
        counter: iv,
        // NIST SP800-38A standard suggests that the counter should occupy half
        // of the counter block
        length: 64,
      };
    }
    return window.crypto.subtle.decrypt(algorithm, key.cryptoKey, rawResult);
  }

  /**
   * Clears the buffer and schedules another update.
   * The optional parameter safeMargin allows to retain a certain amount
   * of buffer, which can help avoiding rebuffering events.
   * The value of the safe margin should be provided by the ABR manager.
   * @param mediaState
   * @param flush
   * @param safeMargin
   */
  private async clearBuffer_(mediaState: MediaState, flush: boolean, safeMargin: number) {
    const logPrefix = StreamingEngine.logPrefix_(mediaState);

    asserts.assert(
      !mediaState.performingUpdate && mediaState.updateTimer == null,
      logPrefix + ' unexpected call to clearBuffer_()'
    );
    mediaState.waitingToClearBuffer = false;
    mediaState.waitingToFlushBuffer = false;
    mediaState.clearBufferSafeMargin = 0;
    mediaState.clearingBuffer = true;
    mediaState.lastSegmentReference = null;
    mediaState.lastInitSegmentReference = null;
    mediaState.segmentIterator = null;
    log.debug(logPrefix, 'clearing buffer');
    if (mediaState.segmentPrefetch && !this.audioPrefetchMap_.has(mediaState.stream)) {
      mediaState.segmentPrefetch.clearAll();
    }

    if (safeMargin) {
      const presentationTime = this.playerInterface_.getPresentationTime();
      const duration = this.playerInterface_.mediaSourceEngine.getDuration();
      await this.playerInterface_.mediaSourceEngine.remove(mediaState.type, presentationTime + safeMargin, duration);
    } else {
      await this.playerInterface_.mediaSourceEngine.clear(mediaState.type);
      this.destroyer_.ensureNotDestroyed();

      if (flush) {
        await this.playerInterface_.mediaSourceEngine.flush(mediaState.type);
      }
    }

    this.destroyer_.ensureNotDestroyed();

    log.debug(logPrefix, 'cleared buffer');
    mediaState.clearingBuffer = false;
    mediaState.endOfStream = false;
    // Since the clear operation was async, check to make sure we're not doing
    // another update and we don't have one scheduled yet.
    if (!mediaState.performingUpdate && !mediaState.updateTimer) {
      this.scheduleUpdate_(mediaState, 0);
    }
  }

  /**
   * Schedules |mediaState|'s next update.
   * @param mediaState
   * @param delay The delay in seconds.
   */
  private scheduleUpdate_(mediaState: MediaState, delay: number) {
    const logPrefix = StreamingEngine.logPrefix_(mediaState);

    // If the text's update is canceled and its mediaState is deleted, stop
    // scheduling another update.
    const type = mediaState.type;
    if (type == ManifestParserUtils.ContentType.TEXT && !this.mediaStates_.has(type)) {
      log.v1(logPrefix, 'Text stream is unloaded. No update is needed.');
      return;
    }

    log.v2(logPrefix, 'updating in ' + delay + ' seconds');
    asserts.assert(mediaState.updateTimer == null, logPrefix + ' did not expect update to be scheduled');

    mediaState.updateTimer = new DelayedTick(async () => {
      try {
        await this.onUpdate_(mediaState);
      } catch (error: any) {
        if (this.playerInterface_) {
          this.playerInterface_.onError(error);
        }
      }
    }).tickAfter(delay);
  }

  /**
   * If |mediaState| is scheduled to update, stop it.
   *
   * @param mediaState
   * @private
   */
  cancelUpdate_(mediaState: MediaState) {
    if (mediaState.updateTimer == null) {
      return;
    }

    mediaState.updateTimer.stop();
    mediaState.updateTimer = null;
  }

  /**
   * If |mediaState| holds any in-progress operations, abort them.
   * @param mediaState
   */
  async abortOperations_(mediaState: MediaState) {
    if (mediaState.operation) {
      await mediaState.operation.abort();
    }
  }

  /**
   * Handle streaming errors by delaying, then notifying the application by
   * error callback and by streaming failure callback.
   *
   * @param mediaState
   * @param error
   */
  private async handleStreamingError_(mediaState: MediaState, error: ShakaError) {
    // If we invoke the callback right away, the application could trigger a
    // rapid retry cycle that could be very unkind to the server.  Instead,
    // use the backoff system to delay and backoff the error handling.
    await this.failureCallbackBackoff_.attempt();
    this.destroyer_.ensureNotDestroyed();

    const maxDisabledTime = this.getDisabledTime_(error);
    // Try to recover from network errors
    if (error.category === ShakaError.Category.NETWORK && maxDisabledTime > 0) {
      error.handled = this.playerInterface_.disableStream(mediaState.stream, maxDisabledTime);

      // Decrease the error severity to recoverable
      if (error.handled) {
        error.severity = ShakaError.Severity.RECOVERABLE;
      }
    }

    // First fire an error event.
    this.playerInterface_.onError(error);

    // If the error was not handled by the application, call the failure
    // callback.
    if (!error.handled) {
      this.config_.failureCallback(error);
    }
  }

  getDisabledTime_(error: ShakaError) {
    if (this.config_.maxDisabledTime === 0 && error.code == ShakaError.Code.SEGMENT_MISSING) {
      // Spec: https://datatracker.ietf.org/doc/html/draft-pantos-hls-rfc8216bis#section-6.3.3
      // The client SHOULD NOT attempt to load Media Segments that have been
      // marked with an EXT-X-GAP tag, or to load Partial Segments with a
      // GAP=YES attribute. Instead, clients are encouraged to look for
      // another Variant Stream of the same Rendition which does not have the
      // same gap, and play that instead.
      return 1;
    }

    return this.config_.maxDisabledTime;
  }

  /**
   * Reset Media Source
   *
   */
  async resetMediaSource() {
    const now = Date.now() / 1000;
    const minTimeBetweenRecoveries = this.config_.minTimeBetweenRecoveries;
    if (!this.config_.allowMediaSourceRecoveries || now - this.lastMediaSourceReset_ < minTimeBetweenRecoveries) {
      return false;
    }
    this.lastMediaSourceReset_ = now;
    const audioMediaState = this.mediaStates_.get(ContentType.AUDIO);
    if (audioMediaState) {
      audioMediaState.lastInitSegmentReference = null;
      this.forceClearBuffer_(audioMediaState);
      this.abortOperations_(audioMediaState).catch(() => {});
    }
    const videoMediaState = this.mediaStates_.get(ContentType.VIDEO);
    if (videoMediaState) {
      videoMediaState.lastInitSegmentReference = null;
      this.forceClearBuffer_(videoMediaState);
      this.abortOperations_(videoMediaState).catch(() => {});
    }
    const streamsByType = new Map();
    if (this.currentVariant_!.audio) {
      streamsByType.set(ContentType.AUDIO, this.currentVariant_!.audio);
    }
    if (this.currentVariant_!.video) {
      streamsByType.set(ContentType.VIDEO, this.currentVariant_!.video);
    }
    await this.playerInterface_.mediaSourceEngine.reset(streamsByType);
    return true;
  }

  /**
   * Update the spatial video info and notify to the app.
   *
   * @param  info
   * @private
   */
  updateSpatialVideoInfo_(info: SpatialVideoInfo) {
    if (this.spatialVideoInfo_.projection != info.projection || this.spatialVideoInfo_.hfov != info.hfov) {
      const EventName = FakeEvent.EventName;
      let event;
      if (info.projection != null || info.hfov != null) {
        const eventName = EventName.SpatialVideoInfoEvent;
        const data = new Map().set('detail', info);
        event = new FakeEvent(eventName, data);
      } else {
        const eventName = EventName.NoSpatialVideoInfoEvent;
        event = new FakeEvent(eventName);
      }
      event.cancelable = true;
      this.playerInterface_.onEvent(event);
      this.spatialVideoInfo_ = info;
    }
  }

  /**
   * Update the segment iterator direction.
   *
   * @private
   */
  updateSegmentIteratorReverse_() {
    const reverse = this.playerInterface_.getPlaybackRate() < 0;
    const videoState = this.mediaStates_.get(ContentType.VIDEO);
    if (videoState && videoState.segmentIterator) {
      videoState.segmentIterator.setReverse(reverse);
    }
    const audioState = this.mediaStates_.get(ContentType.AUDIO);
    if (audioState && audioState.segmentIterator) {
      audioState.segmentIterator.setReverse(reverse);
    }
    const textState = this.mediaStates_.get(ContentType.TEXT);
    if (textState && textState.segmentIterator) {
      textState.segmentIterator.setReverse(reverse);
    }
  }

  static dispatchFetch(
    reference: InitSegmentReference | SegmentReference,
    stream: Stream,
    streamDataCallback: StreamDataCallback,
    retryParameters: RetryParameters,
    netEngine: NetworkingEngine
  ) {
    const requestType = NetworkingEngineRequestType.SEGMENT;
    const segment = reference instanceof SegmentReference ? reference : undefined;
    const type = segment
      ? NetworkingEngineAdvancedRequestType.MEDIA_SEGMENT
      : NetworkingEngineAdvancedRequestType.INIT_SEGMENT;
    const request = Networking.createSegmentRequest(
      reference.getUris(),
      reference.startByte,
      reference.endByte,
      retryParameters,
      streamDataCallback
    );

    request.contentType = stream.type;

    log.v2('fetching: reference=', reference);

    return netEngine.request(requestType, request, { type, stream, segment });
  }

  /**
   * @param mediaState
   * @return A log prefix of the form ($CONTENT_TYPE:$STREAM_ID), e.g.,
   *   "(audio:5)" or "(video:hd)".
   */
  private static logPrefix_(mediaState: MediaState) {
    return '(' + mediaState.type + ':' + mediaState.stream.id + ')';
  }

  /**
   * The fudge factor for appendWindowStart.  By adjusting the window backward, we
   * avoid rounding errors that could cause us to remove the keyframe at the start
   * of the Period.
   *
   * NOTE: This was increased as part of the solution to
   * https://github.com/shaka-project/shaka-player/issues/1281
   *
   */
  private static APPEND_WINDOW_START_FUDGE_ = 0.1;
  /**
   * The fudge factor for appendWindowEnd.  By adjusting the window backward, we
   * avoid rounding errors that could cause us to remove the last few samples of
   * the Period.  This rounding error could then create an artificial gap and a
   * stutter when the gap-jumping logic takes over.
   *
   */
  private static APPEND_WINDOW_END_FUDGE_ = 0.01;
  /**
   * The maximum number of segments by which a stream can get ahead of other
   * streams.
   *
   * Introduced to keep StreamingEngine from letting one media type get too far
   * ahead of another.  For example, audio segments are typically much smaller
   * than video segments, so in the time it takes to fetch one video segment, we
   * could fetch many audio segments.  This doesn't help with buffering, though,
   * since the intersection of the two buffered ranges is what counts.
   */
  private static MAX_RUN_AHEAD_SEGMENTS_ = 1;
}

export interface StreamingEnginePlayerInterface {
  /**
   * Get the position in the presentation (in seconds) of the content that the
   *   viewer is seeing on screen right now.
   */
  getPresentationTime: () => number;
  /**
   * Get the estimated bandwidth in bits per second.
   */
  getBandwidthEstimate: () => number;
  // Get the playback rate
  getPlaybackRate: () => number;
  // The MediaSourceEngine. The caller retains ownership.
  mediaSourceEngine: MediaSourceEngine;
  //  The NetworkingEngine instance to use. The caller retains ownership.
  netEngine: NetworkingEngine;
  /**
   * Called when an error occurs. If the error is recoverable then the caller may invoke either
   *   StreamingEngine.switch*() or StreamingEngine.seeked() to attempt
   */
  onError: (error: ShakaError) => void;
  // Called when an event occurs that should be sent to the app.
  onEvent: (event: FakeEvent) => void;

  // Called when an embedded 'emsg' box should trigger a manifest update.
  onManifestUpdate: () => void;
  /**
   * Called after a segment is successfully appended to a MediaSource.
   */
  onSegmentAppended: (reference: SegmentReference, stream: Stream) => void;

  onInitSegmentAppended: (startTime: number, reference: InitSegmentReference) => void;
  // A function called just before appending to the source buffer.
  beforeAppendSegment: (contentType: string, data: BufferSource) => Promise<void>;
  /**
   * Called to temporarily disable a stream i.e. disabling all variant
   *   containing said stream.
   */
  disableStream: (stream: Stream, maxDisabledTime: number) => boolean;

  onMetadata: OnMetadata;
}

/**
 * @description
 * Contains the state of a logical stream, i.e., a sequence of segmented data
 * for a particular content type. At any given time there is a Stream object
 * associated with the state of the logical stream.
 */
export interface MediaState {
  /**
   * The stream's content type, e.g., 'audio', 'video', or 'text'.
   */
  type: string;
  // The current Stream.
  stream: Stream;
  // An iterator through the segments of |stream|.
  segmentIterator: SegmentIterator | null;
  // The SegmentReference of the last segment that was appended.
  lastSegmentReference: SegmentReference | null;
  // The InitSegmentReference of the last init segment that was appended.
  lastInitSegmentReference: InitSegmentReference | null;
  // The last timestamp offset given to MediaSourceEngine for this type.
  lastTimestampOffset: number | null;
  // The last append window start given to MediaSourceEngine for this type.
  lastAppendWindowStart: number | null;
  // The last append window end given to MediaSourceEngine for this type.
  lastAppendWindowEnd: number | null;
  // The last append codecs given to MediaSourceEngine for this type.
  lastCodecs: string | null;
  // The last append mime type given to MediaSourceEngine for this type.
  lastMimeType: string | null;
  //  The Stream to restore after trick play mode is turned off.
  restoreStreamAfterTrickPlay: Stream | null;
  /**
   * True indicates that the end of the buffer has hit the end of the
   *   presentation.
   */
  endOfStream: boolean;
  //  True indicates that an update is in progress.
  performingUpdate: boolean;
  //  A timer used to update the media state.
  updateTimer: DelayedTick | null;
  /**
   *  True indicates that the buffer must be cleared after the current update
   *   finishes.
   */
  waitingToClearBuffer: boolean;
  // True indicates that the buffer must be flushed after it is cleared.
  waitingToFlushBuffer: boolean;
  // The amount of buffer to retain when clearing the buffer after the update.
  clearBufferSafeMargin: number;
  //  True indicates that the buffer is being cleared.
  clearingBuffer: boolean;
  // True indicates that the presentation just seeked.
  seeked: boolean;
  // True indicates that the presentation just automatically switched variants.
  adaptation?: boolean;
  // True indicates that the last segment was not appended because it could not
  // fit in the buffer.
  recovering: boolean;
  /**
   * True indicates that the stream has encountered an error and has stopped
   *   updating.
   */
  hasError: boolean;
  //   Operation with the number of bytes to be downloaded.
  operation: PendingRequest | null;
  /**
   * A prefetch object for managing prefetching. Null if unneeded
   *   (if prefetching is disabled, etc).
   */
  segmentPrefetch: SegmentPrefetch | null;
}
