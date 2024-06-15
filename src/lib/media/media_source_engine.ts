import { BufferedInfo, ID3Metadata, MediaSourceConfiguration } from '../../externs/shaka';
import { Stream } from '../../externs/shaka/manifest';
import { TextDisplayer } from '../../externs/shaka/text';
import { Transmuxer } from '../../externs/shaka/transmuxer';
import { asserts } from '../debug/asserts';
import { log } from '../debug/log';
import { TextEngine } from '../text/text_engine';
import { TransmuxerEngine } from '../transmuxer/transmuxer_engine';
import { BufferUtils } from '../util/buffer_utils';
import { Destroyer } from '../util/destroyer';
import { ShakaError } from '../util/error';
import { EventManager } from '../util/event_manager';
import { Functional } from '../util/functional';
import { IDestroyable } from '../util/i_destroyable';
import { Id3Utils } from '../util/id3_utils';
import { ManifestParserUtils } from '../util/manifest_parser_utils';
import { MimeUtils } from '../util/mime_utils';
import { Mp4BoxParsers } from '../util/mp4_box_parsers';
import { Mp4Parser } from '../util/mp4_parser';
import { Platform } from '../util/platform';
import { PublicPromise } from '../util/public_promise';
import { StreamUtils } from '../util/stream_utils';
import { ClosedCaptionParser, IClosedCaptionParser } from './closed_caption_parser';
import { ManifestParser } from './manifest_parser';
import { Capabilities } from './media_source_capabilities';
import { SegmentReference } from './segment_reference';
import { TimeRangeUtils } from './time_range_utils';

const ContentType = ManifestParserUtils.ContentType;

type OnMetadata = (metadata: ID3Metadata[], timestampOffset: number, segmentEnd?: number) => void;

/**
 * MediaSourceEngine wraps all operations on MediaSource and SourceBuffers.
 * All asynchronous operations return a Promise, and all operations are
 * internally synchronized and serialized as needed.  Operations that can
 * be done in parallel will be done in parallel.
 *
 *
 *
 */
export class MediaSourceEngine implements IDestroyable {
  private video_: HTMLMediaElement;
  private config_: MediaSourceConfiguration = null as any;
  private textDisplayer_: TextDisplayer;
  private sourceBuffers_: Record<string, SourceBuffer> = {};
  private sourceBufferTypes: Record<string, string> = {};
  private expectedEncryption: Record<string, boolean> = {};

  private textEngine_: TextEngine = null as any;

  private segmentRelativeVttTiming_ = false;

  private onMetadata_: OnMetadata;

  private queues_: Record<string, MediaSourceEngineOperation[]> = {};

  private eventManager_ = new EventManager();
  private transmuxers_: Record<string, Transmuxer> = {};

  private captionParser_: IClosedCaptionParser | null = null;

  private mediaSourceOpen_ = new PublicPromise();

  private url_ = '';

  private playbackHasBegun_ = false;
  private mediaSource_: MediaSource;
  private reloadingMediaSource_ = false;
  private destroyer_ = new Destroyer(() => this.doDestroy_());
  private sequenceMode_ = false;
  private manifestType_ = ManifestParser.UNKNOWN;
  private ignoreManifestTimestampsInSegmentsMode = false;
  private attemptTimestampOffsetCalculation_ = false;
  private textSequenceModeOffset_ = new PublicPromise<number>();
  private needSplitMuxedContent_ = false;
  private streamingAllowed_ = true;
  private lastDuration_: number | null = null;
  // TODO(sanfeng): 实现tsparser
  private tsParser_ = null;

  constructor(video: HTMLMediaElement, textDisplayer: TextDisplayer, onMetadata?: OnMetadata) {
    const onMetadataNoOp = (metadata: ID3Metadata[], timestampOffset: number, segmentEnd?: number) => {};
    this.onMetadata_ = onMetadata || onMetadataNoOp;
    this.mediaSource_ = this.createMediaSource(this.mediaSourceOpen_);
    this.video_ = video;
    this.textDisplayer_ = textDisplayer;
  }

  createMediaSource(p: PublicPromise): MediaSource {
    const mediaSource = new MediaSource();
    this.eventManager_.listenOnce(mediaSource, 'sourceOpen', () => this.onSourceOpen_(p));
    this.eventManager_.listenOnce(this.video_, 'playing', () => {
      this.playbackHasBegun_ = true;
    });

    this.url_ = MediaSourceEngine.createObjectURL(mediaSource);
    this.video_.src = this.url_;

    return mediaSource;
  }

  private onSourceOpen_(p: PublicPromise) {
    URL.revokeObjectURL(this.url_);
    p.resolve();
  }

  /**
   * Checks if a certain type is supported.
   * @param stream
   * @param contentType
   * @returns
   */
  static async isStreamSupported(stream: Stream, contentType: string) {
    if (stream.createSegmentIndex) {
      await stream.createSegmentIndex();
    }

    if (!stream.segmentIndex) {
      return false;
    }

    if (stream.segmentIndex.isEmpty()) {
      return true;
    }

    const seenCombos = new Set();

    for (const ref of stream.segmentIndex) {
      const mimeType = ref.mimeType || stream.mimeType || '';
      let codecs = ref.codecs || stream.codecs || '';

      const combo = mimeType + ':' + codecs;
      if (seenCombos.has(combo)) {
        continue;
      }

      if (contentType === ContentType.TEXT) {
        const fullMimeType = MimeUtils.getFullType(mimeType, codecs);
        if (!TextEngine.isTypeSupported(fullMimeType)) {
          return false;
        }
      } else {
        if (contentType === ContentType.VIDEO) {
          codecs = StreamUtils.getCorrectVideoCodecs(codecs);
        } else if (contentType === ContentType.AUDIO) {
          codecs = StreamUtils.getCorrectAudioCodecs(codecs, mimeType);
        }

        const extendedMimeType = MimeUtils.getExtendedType(stream, mimeType, codecs);
        const fullMimeType = MimeUtils.getFullTypeWithAllCodecs(mimeType, codecs);
        if (
          !Capabilities.isTypeSupported(extendedMimeType) &&
          !TransmuxerEngine.isSupported(fullMimeType, stream.type)
        ) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   *  Returns a map of MediaSource support for well-known types.
   */
  static probeSupport() {
    const testMimeTypes = [
      // MP4 types
      'video/mp4; codecs="avc1.42E01E"',
      'video/mp4; codecs="avc3.42E01E"',
      'video/mp4; codecs="hev1.1.6.L93.90"',
      'video/mp4; codecs="hvc1.1.6.L93.90"',
      'video/mp4; codecs="hev1.2.4.L153.B0"; eotf="smpte2084"', // HDR HEVC
      'video/mp4; codecs="hvc1.2.4.L153.B0"; eotf="smpte2084"', // HDR HEVC
      'video/mp4; codecs="vp9"',
      'video/mp4; codecs="vp09.00.10.08"',
      'video/mp4; codecs="av01.0.01M.08"',
      'video/mp4; codecs="dvh1.20.01"',
      'audio/mp4; codecs="mp4a.40.2"',
      'audio/mp4; codecs="ac-3"',
      'audio/mp4; codecs="ec-3"',
      'audio/mp4; codecs="ac-4"',
      'audio/mp4; codecs="opus"',
      'audio/mp4; codecs="flac"',
      'audio/mp4; codecs="dtsc"', // DTS Digital Surround
      'audio/mp4; codecs="dtse"', // DTS Express
      'audio/mp4; codecs="dtsx"', // DTS:X
      // WebM types
      'video/webm; codecs="vp8"',
      'video/webm; codecs="vp9"',
      'video/webm; codecs="vp09.00.10.08"',
      'audio/webm; codecs="vorbis"',
      'audio/webm; codecs="opus"',
      // MPEG2 TS types (video/ is also used for audio: https://bit.ly/TsMse)
      'video/mp2t; codecs="avc1.42E01E"',
      'video/mp2t; codecs="avc3.42E01E"',
      'video/mp2t; codecs="hvc1.1.6.L93.90"',
      'video/mp2t; codecs="mp4a.40.2"',
      'video/mp2t; codecs="ac-3"',
      'video/mp2t; codecs="ec-3"',
      // WebVTT types
      'text/vtt',
      'application/mp4; codecs="wvtt"',
      // TTML types
      'application/ttml+xml',
      'application/mp4; codecs="stpp"',
      // Containerless types
      ...MimeUtils.RAW_FORMATS,
    ];

    const support: Record<string, boolean> = {};
    for (const type of testMimeTypes) {
      if (TextEngine.isTypeSupported(type)) {
        support[type] = true;
      } else if (Platform.supportsMediaSource()) {
        support[type] = Capabilities.isTypeSupported(type) || TransmuxerEngine.isSupported(type);
      } else {
        support[type] = Platform.supportsMediaType(type);
      }

      const basicType = type.split(';')[0];

      support[basicType] = support[basicType] || support[type];
    }

    return support;
  }

  private async doDestroy_(): Promise<void> {
    const cleanup = [];
    for (const contentType in this.queues_) {
      const q = this.queues_[contentType];
      const inProgress = q[0];
      this.queues_[contentType] = q.slice(0, 1);
      if (inProgress) {
        // @ts-expect-error
        cleanup.push(inProgress.p.catch(Functional.noop));
      }
      for (const item of q.slice(1)) {
        item.p.reject(Destroyer.destroyedError());
      }
    }
    if (this.textEngine_) {
      cleanup.push(this.textEngine_.destroy());
    }

    if (this.textDisplayer_) {
      cleanup.push(this.textDisplayer_.destroy());
    }

    for (const contentType in this.transmuxers_) {
      cleanup.push(this.transmuxers_[contentType].destroy());
    }

    await Promise.all(cleanup);
    if (this.video_) {
      this.video_.removeAttribute('src');
      this.video_.load();
      this.video_ = null as any;
    }

    this.config_ = null as any;
    this.mediaSource_ = null as any;

    this.textEngine_ = null as any;
    this.textDisplayer_ = null as any;
    this.sourceBuffers_ = {};
    this.transmuxers_ = {};
    this.captionParser_ = null;

    this.queues_ = {};
    this.tsParser_ = null;
  }

  destroy() {
    return this.destroyer_.destroy() as any;
  }

  /**
   *
   * @returns Resolved when MediaSource is open and attached to the
   *   media element.  This process is actually initiated by the constructor.
   */
  open() {
    return this.mediaSourceOpen_;
  }

  /**
   *
   * @param streamsByType A map of content types to streams.  All streams must be supported
   *   according to MediaSourceEngine.isStreamSupported.
   * @param sequenceMode If true, the media segments are appended to the SourceBuffer in strict
   *   sequence.
   * @param manifestType Indicates the type of the manifest.
   * @param ignoreManifestTimestampsInSegmentsMode If true, don't adjust the timestamp offset to account for manifest
   *   segment durations being out of sync with segment durations. In other
   *   words, assume that there are no gaps in the segments when appending
   *   to the SourceBuffer, even if the manifest and segment times disagree.
   *   Indicates if the manifest has text streams.
   */
  async init(
    streamsByType: Map<string, Stream>,
    sequenceMode = false,
    manifestType = ManifestParser.UNKNOWN,
    ignoreManifestTimestampsInSegmentsMode = false
  ) {
    await this.mediaSourceOpen_;

    this.sequenceMode_ = sequenceMode;

    this.manifestType_ = manifestType;

    this.ignoreManifestTimestampsInSegmentsMode = ignoreManifestTimestampsInSegmentsMode;

    this.attemptTimestampOffsetCalculation_ =
      !this.sequenceMode_ && this.manifestType_ === ManifestParser.HLS && !this.ignoreManifestTimestampsInSegmentsMode;

    this.tsParser_ = null;

    for (const contentType of streamsByType.keys()) {
      const stream = streamsByType.get(contentType);
      await this.initSourceBuffer_(contentType, stream!, stream!.codecs);

      if (this.needSplitMuxedContent_) {
        this.queues_[ContentType.AUDIO] = [];
        this.queues_[ContentType.VIDEO] = [];
      } else {
        this.queues_[contentType] = [];
      }
    }
  }

  /**
   * Initialize a specific SourceBuffer.
   * @param contentType
   * @param stream
   * @param codecs
   */
  private async initSourceBuffer_(contentType: string, stream: Stream, codecs: string) {
    asserts.assert(
      await MediaSourceEngine.isStreamSupported(stream, contentType),
      'Type negotiation should happen before MediaSourceEngine.init!'
    );

    const mimeType = MimeUtils.getFullType(stream.mimeType, codecs);
    if (contentType === ContentType.TEXT) {
      // TODO(sanfeng): 支持text
    } else {
      let needTransMux = this.config_.forceTransmux;
      if (
        !Capabilities.isTypeSupported(mimeType) ||
        (!this.sequenceMode_ && MimeUtils.RAW_FORMATS.includes(mimeType))
      ) {
        needTransMux = true;
      }

      const mimeTypeWithCodecs = MimeUtils.getFullTypeWithAllCodecs(stream.mimeType, codecs);
      if (needTransMux) {
        // TODO(sanfeng): 支持transmux
      }

      const type = this.addExtraFeaturesToMimeType_(mimeType);

      this.destroyer_.ensureNotDestroyed();

      let sourceBuffer: SourceBuffer;

      try {
        sourceBuffer = this.mediaSource_.addSourceBuffer(type);
      } catch (error) {
        throw new ShakaError(
          ShakaError.Severity.CRITICAL,
          ShakaError.Category.MEDIA,
          ShakaError.Code.MEDIA_SOURCE_OPERATION_THREW,
          error,
          'The mediaSource_ status was ' + this.mediaSource_.readyState + " expected 'open'",
          null
        );
      }

      if (this.sequenceMode_) {
        sourceBuffer.mode = 'sequence';
      }

      this.eventManager_.listen(sourceBuffer, 'error', () => this.onError_(contentType));

      this.eventManager_.listen(sourceBuffer, 'updateend', () => this.onUpdateEnd_(contentType));

      this.sourceBuffers_[contentType] = sourceBuffer;
      this.sourceBufferTypes[contentType] = mimeType;
      this.expectedEncryption[contentType] = !!stream.drmInfos.length;
    }
  }

  /**
   * Called by the Player to provide an updated configuration any time it
   * changes. Must be called at least once before init().
   * @param config
   */
  configure(config: MediaSourceConfiguration) {
    this.config_ = config;
    if (this.textEngine_) {
      this.textEngine_.setModifyCueCallback(config.modifyCueCallback);
    }
  }

  /**
   * Indicate if the streaming is allowed by MediaSourceEngine.
   * If we using MediaSource we allways returns true.
   * @returns
   */
  isStreamingAllowed() {
    return this.streamingAllowed_;
  }

  /**
   *
   * @returns True if the MediaSource is in an "ended" state, or if the
   *   object has been destroyed.
   */
  ended() {
    if (this.reloadingMediaSource_) {
      return false;
    }
    return this.mediaSource_ ? this.mediaSource_.readyState === 'ended' : true;
  }

  /**
   * Gets the first timestamp in buffer for the given content type.
   * @param contentType
   * @returns  The timestamp in seconds, or null if nothing is buffered.
   */
  bufferStart(contentType: string) {
    if (this.reloadingMediaSource_ || !Object.keys(this.sourceBuffers_).length) {
      return null;
    }

    if (contentType === ContentType.TEXT) {
      return this.textEngine_.bufferStart();
    }
    return TimeRangeUtils.bufferStart(this.getBuffered_(contentType));
  }

  /**
   * Gets the last timestamp in buffer for the given content type.
   * @param contentType
   * @returns The timestamp in seconds, or null if nothing is buffered.
   */
  bufferEnd(contentType: string) {
    if (this.reloadingMediaSource_ || !Object.keys(this.sourceBuffers_).length) {
      return null;
    }

    if (contentType === ContentType.TEXT) {
      return this.textEngine_.bufferEnd();
    }
    return TimeRangeUtils.bufferEnd(this.getBuffered_(contentType));
  }

  /**
   * Determines if the given time is inside the buffered range of the given
   * content type.
   *
   * @param contentType
   * @param time Playhead time
   */
  isBuffered(contentType: string, time: number) {
    if (this.reloadingMediaSource_) {
      return false;
    }

    if (contentType == ContentType.TEXT) {
      return this.textEngine_.isBuffered(time);
    } else {
      const buffered = this.getBuffered_(contentType);

      return TimeRangeUtils.isBuffered(buffered, time);
    }
  }

  /**
   * Computes how far ahead of the given timestamp is buffered for the given
   * content type.
   * @param contentType
   * @param time
   */
  bufferedAheadOf(contentType: string, time: number) {
    if (this.reloadingMediaSource_) {
      return 0;
    }

    if (contentType === ContentType.TEXT) {
      return this.textEngine_.bufferedAheadOf(time);
    } else {
      const buffered = this.getBuffered_(contentType);
      return TimeRangeUtils.bufferedAheadOf(buffered, time);
    }
  }

  /**
   * Returns info about what is currently buffered.
   */
  getBufferedInfo(): BufferedInfo {
    const info: BufferedInfo = {
      total: this.reloadingMediaSource_ ? [] : TimeRangeUtils.getBufferedInfo(this.video_.buffered),
      audio: this.reloadingMediaSource_ ? [] : TimeRangeUtils.getBufferedInfo(this.getBuffered_(ContentType.AUDIO)),
      video: this.reloadingMediaSource_ ? [] : TimeRangeUtils.getBufferedInfo(this.getBuffered_(ContentType.VIDEO)),
      text: [],
    };

    if (this.textEngine_) {
      const start = this.textEngine_.bufferStart();
      const end = this.textEngine_.bufferEnd();
      if (start !== null && end !== null) {
        info.text.push({
          start,
          end,
        });
      }
    }

    return info;
  }

  /**
   * @param contentType
   * @return The buffered ranges for the given content type, or
   *   null if the buffered ranges could not be obtained.
   */
  private getBuffered_(contentType: string): TimeRanges | null {
    if (!this.sourceBuffers_[contentType]) {
      return null;
    }
    try {
      return this.sourceBuffers_[contentType].buffered;
    } catch (error) {
      log.error('failed to get buffered range for ' + contentType, error);
    }
    return null;
  }

  /**
   * Create a new closed caption parser. This will ONLY be replaced by tests as
   * a way to inject fake closed caption parser instances.
   *
   * @param  mimeType
   * @return
   */
  getCaptionParser(mimeType: string) {
    return new ClosedCaptionParser(mimeType);
  }

  /**
   *
   * @param contentType
   * @param data
   * @param reference
   * @param mimeType
   * @param timestampOffset
   * @returns
   */
  private getTimestampAndDispatchMetadata_(
    contentType: string,
    data: BufferSource,
    reference: SegmentReference,
    mimeType: string,
    timestampOffset: number
  ) {
    let timestamp: number | null = null;

    const uint8ArrayData = BufferUtils.toUint8(data);

    if (MimeUtils.RAW_FORMATS.includes(mimeType)) {
      const frames = Id3Utils.getID3Frames(uint8ArrayData);
      if (frames.length && reference) {
        const metadataTimestamp = frames.find((frame) => {
          return frame.description === 'com.apple.streaming.transportStreamTimestamp';
        });
        if (metadataTimestamp && metadataTimestamp.data) {
          timestamp = Math.round(metadataTimestamp.data as number) / 1000;
        }

        const metadata: ID3Metadata = {
          cueTime: reference.startTime,
          data: uint8ArrayData,
          frames: frames,
          dts: reference.startTime,
          pts: reference.startTime,
        };
        this.onMetadata_([metadata], 0, reference.endTime);
      }
    } else if (
      mimeType.includes('/mp4') &&
      reference &&
      reference.timestampOffset === 0 &&
      reference.initSegmentReference &&
      reference.initSegmentReference.timescale
    ) {
      const timescale = reference.initSegmentReference.timescale;
      if (!isNaN(timescale)) {
        let startTime = 0;
        let parsedMedia = false;
        new Mp4Parser()
          .box('moof', Mp4Parser.children)
          .box('traf', Mp4Parser.children)
          .fullBox('tfdt', (box) => {
            asserts.assert(box.version === 0 || box.version === 1, 'TFDT version can only be 0 or 1');
            const parsed = Mp4BoxParsers.parseTFDTInaccurate(box.reader, box.version!);
            startTime = parsed.baseMediaDecodeTime / timescale;
            parsedMedia = true;
            box.parser.stop();
          })
          .parse(data, true);
        if (parsedMedia) {
          timestamp = startTime;
        }
      }
    } // TODO(sanfeng): tsParser

    return timestamp;
  }

  /**
   * Enqueue an operation to append data to the SourceBuffer.
   * Start and end times are needed for TextEngine, but not for MediaSource.
   * Start and end times may be null for initialization segments; if present
   * they are relative to the presentation timeline.
   * @param contentType
   * @param data
   * @param reference The segment reference
   *   we are appending, or null for init segments
   * @param stream
   *
   * @param hasClosedCaptions True if the buffer contains CEA closed
   *   captions
   * @param seeked  True if we just seeked
   * @param adaptation True if we just automatically switched active
   *   variant(s).
   * @param isChunkedData True if we add to the buffer from the
   *   partial read of the segment.
   * @param fromSplit
   */
  async appendBuffer(
    contentType: string,
    data: BufferSource,
    reference: SegmentReference,
    stream: Stream,
    hasClosedCaptions: boolean,
    seeked = false,
    adaptation = false,
    isChunkedData = false,
    fromSplit = false
  ) {
    if (contentType === ContentType.TEXT) {
      if (this.sequenceMode_) {
        // This won't be known until the first video segment is appended.
        const offset = await this.textSequenceModeOffset_;
        this.textEngine_.setTimestampOffset(offset as unknown as number);
      }
      await this.textEngine_.appendBuffer(
        data,
        reference ? reference.startTime : null,
        reference ? reference.endTime : null,
        reference ? reference.getUris()[0] : null
      );
      return;
    }
  }

  private addExtraFeaturesToMimeType_(mimeType: string) {
    const extractFeatures = this.config_.addExtraFeaturesToSourceBuffer(mimeType);
    const extendedType = mimeType + extractFeatures;

    log.debug('Using full mime type', extendedType);

    return extendedType;
  }

  /**
   * Enqueue an operation and start it if appropriate.
   * @param contentType
   * @param start
   * @param uri
   */
  enqueueOperation_(contentType: string, start: Function, uri: string) {
    this.destroyer_.ensureNotDestroyed();
    const operation = {
      start,
      p: new PublicPromise(),
      uri,
    };

    this.queues_[contentType].push(operation);

    if (this.queues_[contentType].length === 1) {
      this.startOperation_(contentType);
    }

    return operation.p;
  }

  /**
   * Enqueue an operation which must block all other operations on all
   * SourceBuffers.
   * @param run
   */
  private async enqueueBlockingOperation_(run: () => Promise<void> | undefined) {
    this.destroyer_.ensureNotDestroyed();

    // Enqueue a 'wait' operation onto each queue.
    // This operation signals its readiness when it starts.
    // When all wait operations are ready, the real operation takes place.
    const allWaiters: PublicPromise[] = [];
    for (const contentType in this.sourceBuffers_) {
      const ready = new PublicPromise();
      const operation = {
        start: () => ready.resolve(),
        p: ready,
        uri: null,
      };

      this.queues_[contentType].push(operation);
      allWaiters.push(ready);

      if (this.queues_[contentType].length == 1) {
        operation.start();
      }
    }

    // Return a Promise to the real operation, which waits to begin until
    // there are no other in-progress operations on any SourceBuffers.
    try {
      await Promise.all(allWaiters);
    } catch (error) {
      // One of the waiters failed, which means we've been destroyed.
      asserts.assert(this.destroyer_.destroyed(), 'Should be destroyed by now');
      // We haven't popped from the queue.  Canceled waiters have been removed
      // by destroy.  What's left now should just be resolved waiters.  In
      // uncompiled mode, we will maintain good hygiene and make sure the
      // assert at the end of destroy passes.  In compiled mode, the queues
      // are wiped in destroy.
      if (__DEV__) {
        for (const contentType in this.sourceBuffers_) {
          if (this.queues_[contentType].length) {
            asserts.assert(this.queues_[contentType].length == 1, 'Should be at most one item in queue!');
            asserts.assert(
              allWaiters.includes(this.queues_[contentType][0].p),
              'The item in queue should be one of our waiters!'
            );
            this.queues_[contentType].shift();
          }
        }
      }
      throw error;
    }
    // Run the real operation, which can be asynchronous.
    try {
      await run();
    } catch (exception) {
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.MEDIA,
        ShakaError.Code.MEDIA_SOURCE_OPERATION_THREW,
        exception,
        this.video_.error || 'No error in the media element',
        null
      );
    } finally {
      // Unblock the queues.
      for (const contentType in this.sourceBuffers_) {
        this.popFromQueue_(contentType);
      }
    }
  }

  /**
   * Starts the next operation in the queue.
   * @param contentType
   */
  startOperation_(contentType: string) {
    const next = this.queues_[contentType][0];
    if (next) {
      try {
        next.start();
      } catch (exception: any) {
        if (exception.name == 'QuotaExceededError') {
          next.p.reject(
            new ShakaError(
              ShakaError.Severity.CRITICAL,
              ShakaError.Category.MEDIA,
              ShakaError.Code.QUOTA_EXCEEDED_ERROR,
              contentType
            )
          );
        } else {
          next.p.reject(
            new ShakaError(
              ShakaError.Severity.CRITICAL,
              ShakaError.Category.MEDIA,
              ShakaError.Code.MEDIA_SOURCE_OPERATION_THREW,
              exception,
              this.video_.error || 'No error in the media element',
              next.uri
            )
          );
        }
        this.popFromQueue_(contentType);
      }
    }
  }

  /**
   * Pop from the front of the queue and start a new operation.
   * @param contentType
   */
  private popFromQueue_(contentType: string) {
    // Remove the in-progress operation, which is now complete.
    this.queues_[contentType].shift();
    this.startOperation_(contentType);
  }

  private static SourceBufferMode_ = {
    SEQUENCE: 'sequence',
    SEGMENTS: 'segments',
  };

  static createObjectURL = window.URL.createObjectURL;
}

export interface MediaSourceEngineOperation {
  start: Function;
  p: PublicPromise;
  uri: string | null;
}
