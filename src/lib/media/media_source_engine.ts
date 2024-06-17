import { BufferedInfo, ID3Metadata, MediaSourceConfiguration } from '../../externs/shaka';
import { Stream } from '../../externs/shaka/manifest';
import { TextDisplayer } from '../../externs/shaka/text';
import { Transmuxer } from '../../externs/shaka/transmuxer';
import { CodecSwitchingStrategy } from '../config/codec_switching_strategy';
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
import { TimeRangesUtils } from './time_range_utils';

const ContentType = ManifestParserUtils.ContentType;

export type OnMetadata = (metadata: ID3Metadata[], timestampOffset: number, segmentEnd: number | null) => void;

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
  private textDisplayer_: TextDisplayer | null;
  private sourceBuffers_: Record<string, SourceBuffer> = {};
  private sourceBufferTypes_: Record<string, string> = {};
  private expectedEncryption_: Record<string, boolean> = {};

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
  private lastDuration_: number = null as any;
  // TODO(sanfeng): TsParser
  private tsParser_ = null;

  constructor(video: HTMLMediaElement, textDisplayer: TextDisplayer | null, onMetadata?: OnMetadata) {
    const onMetadataNoOp = (metadata: ID3Metadata[], timestampOffset: number, segmentEnd: number | null) => {};
    this.onMetadata_ = onMetadata || onMetadataNoOp;
    this.mediaSource_ = this.createMediaSource(this.mediaSourceOpen_);
    this.video_ = video;
    this.textDisplayer_ = textDisplayer;
  }

  createMediaSource(p: PublicPromise): MediaSource {
    const mediaSource = new MediaSource();
    this.eventManager_.listenOnce(mediaSource, 'sourceopen', () => this.onSourceOpen_(p));
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
      // TODO(sanfeng): TextEngine
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
        // TODO(sanfeng): TransmuxerEngine
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
      this.sourceBufferTypes_[contentType] = mimeType;
      this.expectedEncryption_[contentType] = !!stream.drmInfos.length;
    }
  }

  /**
   * Called by the Player to provide an updated configuration any time it
   * changes. Must be called at least once before init().
   * @param config
   */
  configure(config: MediaSourceConfiguration) {
    this.config_ = config;
    // TODO(sanfeng): TextEngine
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
    return TimeRangesUtils.bufferStart(this.getBuffered_(contentType));
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
    return TimeRangesUtils.bufferEnd(this.getBuffered_(contentType));
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

      return TimeRangesUtils.isBuffered(buffered, time);
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

    // TODO(sanfeng): TextEngine
    if (contentType === ContentType.TEXT) {
      return this.textEngine_.bufferedAheadOf(time);
    } else {
      const buffered = this.getBuffered_(contentType);
      return TimeRangesUtils.bufferedAheadOf(buffered, time);
    }
  }

  /**
   * Returns info about what is currently buffered.
   */
  getBufferedInfo(): BufferedInfo {
    const info: BufferedInfo = {
      total: this.reloadingMediaSource_ ? [] : TimeRangesUtils.getBufferedInfo(this.video_.buffered),
      audio: this.reloadingMediaSource_ ? [] : TimeRangesUtils.getBufferedInfo(this.getBuffered_(ContentType.AUDIO)),
      video: this.reloadingMediaSource_ ? [] : TimeRangesUtils.getBufferedInfo(this.getBuffered_(ContentType.VIDEO)),
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
    } // TODO(sanfeng): TsParser

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
    reference: SegmentReference | null,
    stream: Stream,
    hasClosedCaptions: boolean | null,
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

    if (!fromSplit && this.needSplitMuxedContent_) {
      await this.appendBuffer(
        ContentType.AUDIO,
        data,
        reference,
        stream,
        hasClosedCaptions,
        seeked,
        adaptation,
        isChunkedData,
        /* fromSplit= */ true
      );
      await this.appendBuffer(
        ContentType.VIDEO,
        data,
        reference,
        stream,
        hasClosedCaptions,
        seeked,
        adaptation,
        isChunkedData,
        /* fromSplit= */ true
      );
      return;
    }

    if (!this.sourceBuffers_[contentType]) {
      log.warning('Attempted to restore a non-existent source buffer');
      return;
    }

    let timestampOffset = this.sourceBuffers_[contentType].timestampOffset;
    let mimeType = this.sourceBufferTypes_[contentType];
    if (this.transmuxers_[contentType]) {
      // TODO(sanfeng): TransmuxerEngine
      // mimeType = this.transmuxers_[contentType].getOriginalMimeType();
    }

    if (reference) {
      const timestamp = this.getTimestampAndDispatchMetadata_(contentType, data, reference, mimeType, timestampOffset);
      if (timestamp !== null) {
        const calculatedTimestampOffset = reference.startTime - timestamp;
        const timestampOffsetDifference = Math.abs(timestampOffset - calculatedTimestampOffset);
        if (
          (timestampOffsetDifference >= 0.001 || seeked || adaptation) &&
          (!isChunkedData || calculatedTimestampOffset > 0 || !timestampOffset)
        ) {
          timestampOffset = calculatedTimestampOffset;
          if (this.attemptTimestampOffsetCalculation_) {
            this.enqueueOperation_(contentType, () => this.abort_(contentType), null);
            this.enqueueOperation_(contentType, () => this.setTimestampOffset_(contentType, timestampOffset), null);
          }
        }

        // Timestamps can only be reliably extracted from video, not audio.
        // Packed audio formats do not have internal timestamps at all.
        // Prefer video for this when available.
        const isBestSourceBufferForTimestamps =
          contentType == ContentType.VIDEO || !(ContentType.VIDEO in this.sourceBuffers_);
        if (this.sequenceMode_ && isBestSourceBufferForTimestamps) {
          this.textSequenceModeOffset_.resolve(timestampOffset);
        }
      }
    }

    if (hasClosedCaptions && contentType === ContentType.VIDEO) {
      // TODO(sanfeng) IClosedCaptionParser
    }

    if (this.transmuxers_[contentType]) {
      // TODO(sanfeng): TransmuxerEngine
    }

    data = this.workAroundBrokenPlatforms_(
      data,
      reference ? reference.startTime : null,
      contentType,
      reference ? reference.getUris()[0] : null
    );
    if (reference && this.sequenceMode_ && contentType !== ContentType.TEXT) {
      // In sequence mode, for non-text streams, if we just cleared the buffer
      // and are either performing an unbuffered seek or handling an automatic
      // adaptation, we need to set a new timestampOffset on the sourceBuffer.
      if (seeked || adaptation) {
        const timestampOffset = reference.startTime;
        // The logic to call abort() before setting the timestampOffset is
        // extended during unbuffered seeks or automatic adaptations; it is
        // possible for the append state to be PARSING_MEDIA_SEGMENT from the
        // previous SourceBuffer#appendBuffer() call.
        this.enqueueOperation_(contentType, () => this.abort_(contentType), null);
        this.enqueueOperation_(contentType, () => this.setTimestampOffset_(contentType, timestampOffset), null);
      }
    }

    let bufferedBefore: TimeRanges | null = null;
    await this.enqueueOperation_(
      contentType,
      () => {
        if (__DEV__ && reference && !reference.isPreload() && !isChunkedData) {
          bufferedBefore = this.getBuffered_(contentType);
        }

        this.append_(contentType, data, timestampOffset);
      },
      reference ? reference.getUris()[0] : null
    );

    if (__DEV__ && reference && !reference.isPreload() && !isChunkedData) {
      const bufferedAfter = this.getBuffered_(contentType);
      const newBuffered = TimeRangesUtils.computeAddedRange(bufferedBefore, bufferedAfter);
      if (newBuffered) {
        const segmentDuration = reference.endTime - reference.startTime;
        // Check end times instead of start times.  We may be overwriting a
        // buffer and only the end changes, and that would be fine.
        // Also, exclude tiny segments.  Sometimes alignment segments as small
        // as 33ms are seen in Google DAI content.  For such tiny segments,
        // half a segment duration would be no issue.
        const offset = Math.abs(newBuffered.end - reference.endTime);
        if (segmentDuration > 0.1 && offset > segmentDuration / 2) {
          log.error(
            'Possible encoding problem detected!',
            'Unexpected buffered range for reference',
            reference,
            'from URIs',
            reference.getUris(),
            'should be',
            { start: reference.startTime, end: reference.endTime },
            'but got',
            newBuffered
          );
        }
      }
    }
  }

  /**
   * Enqueue an operation to remove data from the SourceBuffer.
   * @param contentType
   * @param startTime relative to the start of the presentation
   * @param endTime relative to the start of the presentation
   */
  async remove(contentType: string, startTime: number, endTime: number) {
    if (contentType === ContentType.TEXT) {
      this.textEngine_.remove(startTime, endTime);
    } else {
      await this.enqueueOperation_(contentType, () => this.remove_(contentType, startTime, endTime), null);
      if (this.needSplitMuxedContent_) {
        await this.enqueueOperation_(ContentType.AUDIO, () => this.remove_(contentType, startTime, endTime), null);
      }
    }
  }

  /**
   * Enqueue an operation to clear the SourceBuffer.
   * @param contentType
   */
  async clear(contentType: string) {
    if (contentType === ContentType.TEXT) {
      if (!this.textEngine_) {
        return;
      }

      await this.textEngine_.remove(0, Infinity);
    } else {
      await this.enqueueOperation_(contentType, () => this.remove_(contentType, 0, this.mediaSource_.duration), null);
      if (this.needSplitMuxedContent_) {
        await this.enqueueOperation_(
          ContentType.AUDIO,
          () => this.remove_(ContentType.AUDIO, 0, this.mediaSource_.duration),
          null
        );
      }
    }
  }

  /**
   * Fully reset the state of the caption parser owned by MediaSourceEngine.
   */
  resetCaptionParser() {
    if (this.captionParser_) {
      this.captionParser_.reset();
    }
  }
  /**
   * Enqueue an operation to flush the SourceBuffer.
   * This is a workaround for what we believe is a Chromecast bug.
   * @param contentType
   */
  async flush(contentType: string) {
    if (contentType == ContentType.TEXT) {
      // Nothing to flush for text.
      return;
    }
    await this.enqueueOperation_(contentType, () => this.flush_(contentType), null);
    if (this.needSplitMuxedContent_) {
      await this.enqueueOperation_(ContentType.AUDIO, () => this.flush_(ContentType.AUDIO), null);
    }
  }

  /**
   * Sets the timestamp offset and append window end for the given content type.
   * @param contentType
   * @param timestampOffset The timestamp offset.  Segments which start
   *   at time t will be inserted at time t + timestampOffset instead.  This
   *   value does not affect segments which have already been inserted.
   * @param appendWindowStart The timestamp to set the append window
   *   start to.  For future appends, frames/samples with timestamps less than
   *   this value will be dropped.
   * @param appendWindowEnd he timestamp to set the append window end
   *   to.  For future appends, frames/samples with timestamps greater than this
   *   value will be dropped.
   * @param ignoreTimestampOffset If true, the timestampOffset will
   *   not be applied in this step.
   * @param mimeType
   * @param codecs
   * @param streamsByType A map of content types to streams.  All streams must be supported
   *   according to MediaSourceEngine.isStreamSupported.
   */
  async setStreamProperties(
    contentType: string,
    timestampOffset: number,
    appendWindowStart: number,
    appendWindowEnd: number,
    ignoreTimestampOffset: boolean,
    mimeType: string,
    codecs: string,
    streamsByType: Map<string, Stream>
  ) {
    if (contentType == ContentType.TEXT) {
      if (!ignoreTimestampOffset) {
        this.textEngine_.setTimestampOffset(timestampOffset);
      }
      this.textEngine_.setAppendWindow(appendWindowStart, appendWindowEnd);
      return;
    }

    const operations: PublicPromise[] = [];

    const hasChangedCodecs = await this.codecSwitchIfNecessary_(contentType, mimeType, codecs, streamsByType);
    if (!hasChangedCodecs) {
      // Queue an abort() to help MSE splice together overlapping segments.
      // We set appendWindowEnd when we change periods in DASH content, and the
      // period transition may result in overlap.
      //
      // An abort() also helps with MPEG2-TS.  When we append a TS segment, we
      // always enter a PARSING_MEDIA_SEGMENT state and we can't change the
      // timestamp offset.  By calling abort(), we reset the state so we can
      // set it.
      operations.push(this.enqueueOperation_(contentType, () => this.abort_(contentType), null));
      if (this.needSplitMuxedContent_) {
        operations.push(this.enqueueOperation_(ContentType.AUDIO, () => this.abort_(ContentType.AUDIO), null));
      }
    }
    if (!ignoreTimestampOffset) {
      operations.push(
        this.enqueueOperation_(contentType, () => this.setTimestampOffset_(contentType, timestampOffset), null)
      );
      if (this.needSplitMuxedContent_) {
        operations.push(
          this.enqueueOperation_(
            ContentType.AUDIO,
            () => this.setTimestampOffset_(ContentType.AUDIO, timestampOffset),
            null
          )
        );
      }
    }
    operations.push(
      this.enqueueOperation_(
        contentType,
        () => this.setAppendWindow_(contentType, appendWindowStart, appendWindowEnd),
        null
      )
    );
    if (this.needSplitMuxedContent_) {
      operations.push(
        this.enqueueOperation_(
          ContentType.AUDIO,
          () => this.setAppendWindow_(ContentType.AUDIO, appendWindowStart, appendWindowEnd),
          null
        )
      );
    }

    await Promise.all(operations);
  }

  /**
   * Adjust timestamp offset to maintain AV sync across discontinuities.
   * @param contentType
   * @param timestampOffset
   */
  async resync(contentType: string, timestampOffset: number) {
    if (contentType === ContentType.TEXT) {
      return;
    }

    // Reset the promise in case the timestamp offset changed during
    // a period/discontinuity transition.
    if (contentType === ContentType.VIDEO) {
      this.textSequenceModeOffset_ = new PublicPromise();
    }
    // Queue an abort() to help MSE splice together overlapping segments.
    // We set appendWindowEnd when we change periods in DASH content, and the
    // period transition may result in overlap.
    //
    // An abort() also helps with MPEG2-TS.  When we append a TS segment, we
    // always enter a PARSING_MEDIA_SEGMENT state and we can't change the
    // timestamp offset.  By calling abort(), we reset the state so we can
    // set it.
    this.enqueueOperation_(contentType, () => this.abort_(contentType), null);
    if (this.needSplitMuxedContent_) {
      this.enqueueOperation_(ContentType.AUDIO, () => this.abort_(ContentType.AUDIO), null);
    }
    await this.enqueueOperation_(contentType, () => this.setTimestampOffset_(contentType, timestampOffset), null);
    if (this.needSplitMuxedContent_) {
      await this.enqueueOperation_(
        ContentType.AUDIO,
        () => this.setTimestampOffset_(ContentType.AUDIO, timestampOffset),
        null
      );
    }
  }

  /**
   *
   * @param reason  reason Valid reasons are 'network' and 'decode'.
   */
  async endOfStream(reason?: EndOfStreamError) {
    await this.enqueueBlockingOperation_(() => {
      if (this.ended() || this.mediaSource_.readyState === 'closed') {
        return;
      }
      if (reason) {
        this.mediaSource_.endOfStream(reason);
      } else {
        this.mediaSource_.endOfStream();
      }
    });
  }

  /**
   *
   * @param duration
   */
  async setDuration(duration: number) {
    await this.enqueueBlockingOperation_(() => {
      // Reducing the duration causes the MSE removal algorithm to run, which
      // triggers an 'updateend' event to fire.  To handle this scenario, we
      // have to insert a dummy operation into the beginning of each queue,
      // which the 'updateend' handler will remove.
      if (duration < this.mediaSource_.duration) {
        for (const contentType in this.sourceBuffers_) {
          const dummyOperation = {
            start: () => {},
            p: new PublicPromise(),
            uri: null,
          };
          this.queues_[contentType].unshift(dummyOperation);
        }
      }

      this.mediaSource_.duration = duration;
      this.lastDuration_ = duration;
    });
  }

  /**
   * Get the current MediaSource duration.
   *
   */
  getDuration() {
    return this.mediaSource_.duration;
  }

  /**
   * Append data to the SourceBuffer.
   * @param contentType
   * @param data
   * @param timestampOffset
   */
  append_(contentType: string, data: BufferSource, timestampOffset: number) {
    this.sourceBuffers_[contentType].appendBuffer(data);
  }

  /**
   * Remove data from the SourceBuffer.
   * @param contentType
   * @param startTime relative to the start of the presentation
   * @param  endTime relative to the start of the presentation
   * @private
   */
  remove_(contentType: string, startTime: number, endTime: number) {
    if (endTime <= startTime) {
      // Ignore removal of inverted or empty ranges.
      // Fake 'updateend' event to resolve the operation.
      this.onUpdateEnd_(contentType);
      return;
    }

    // This will trigger an 'updateend' event.
    this.sourceBuffers_[contentType].remove(startTime, endTime);
  }

  /**
   * Set the SourceBuffer's append window end.
   * @param contentType
   * @param appendWindowStart
   * @param appendWindowEnd
   * @private
   */
  private setAppendWindow_(contentType: string, appendWindowStart: number, appendWindowEnd: number) {
    // You can't set start > end, so first set start to 0, then set the new
    // end, then set the new start.  That way, there are no intermediate
    // states which are invalid.
    this.sourceBuffers_[contentType].appendWindowStart = 0;
    this.sourceBuffers_[contentType].appendWindowEnd = appendWindowEnd;
    this.sourceBuffers_[contentType].appendWindowStart = appendWindowStart;

    // Fake an 'updateend' event to resolve the operation.
    this.onUpdateEnd_(contentType);
  }

  /**
   * Nudge the playhead to force the media pipeline to be flushed.
   * This seems to be necessary on Chromecast to get new content to replace old
   * content.
   * @param contentType
   * @private
   */
  flush_(contentType: string) {
    // Never use flush_ if there's data.  It causes a hiccup in playback.
    asserts.assert(
      this.video_.buffered.length == 0,
      'MediaSourceEngine.flush_ should ' + 'only be used after clearing all data!'
    );

    // Seeking forces the pipeline to be flushed.
    this.video_.currentTime -= 0.001;

    // Fake an 'updateend' event to resolve the operation.
    this.onUpdateEnd_(contentType);
  }

  /**
   * Set the SourceBuffer's timestamp offset.
   * @param contentType
   * @param timestampOffset
   */
  private setTimestampOffset_(contentType: string, timestampOffset: number) {
    // Work around for
    // https://github.com/shaka-project/shaka-player/issues/1281:
    // TODO(https://bit.ly/2ttKiBU): follow up when this is fixed in Edge
    if (timestampOffset < 0) {
      // Try to prevent rounding errors in Edge from removing the first
      // keyframe.
      timestampOffset += 0.001;
    }

    this.sourceBuffers_[contentType].timestampOffset = timestampOffset;

    // Fake an 'updateend' event to resolve the operation.
    this.onUpdateEnd_(contentType);
  }

  /**
   * Call abort() on the SourceBuffer.
   * This resets MSE's last_decode_timestamp on all track buffers, which should
   * trigger the splicing logic for overlapping segments.
   * @param contentType
   */
  private abort_(contentType: string) {
    // Save the append window, which is reset on abort().
    const appendWindowStart = this.sourceBuffers_[contentType].appendWindowStart;
    const appendWindowEnd = this.sourceBuffers_[contentType].appendWindowEnd;

    // This will not trigger an 'updateend' event, since nothing is happening.
    // This is only to reset MSE internals, not to abort an actual operation.
    this.sourceBuffers_[contentType].abort();

    // Restore the append window.
    this.sourceBuffers_[contentType].appendWindowStart = appendWindowStart;
    this.sourceBuffers_[contentType].appendWindowEnd = appendWindowEnd;

    // Fake an 'updateend' event to resolve the operation.
    this.onUpdateEnd_(contentType);
  }

  /**
   * @param {shaka.util.ManifestParserUtils.ContentType} contentType
   * @private
   */
  private onError_(contentType: string) {
    const operation = this.queues_[contentType][0];
    asserts.assert(operation, 'Spurious error event!');
    asserts.assert(!this.sourceBuffers_[contentType].updating, 'SourceBuffer should not be updating on error!');
    const code = this.video_.error ? this.video_.error.code : 0;
    operation.p.reject(
      new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.MEDIA,
        ShakaError.Code.MEDIA_SOURCE_OPERATION_FAILED,
        code,
        operation.uri
      )
    );
    // Do not pop from queue.  An 'updateend' event will fire next, and to
    // avoid synchronizing these two event handlers, we will allow that one to
    // pop from the queue as normal.  Note that because the operation has
    // already been rejected, the call to resolve() in the 'updateend' handler
    // will have no effect.
  }

  /**
   * @param contentType
   */
  private onUpdateEnd_(contentType: string) {
    if (this.reloadingMediaSource_) {
      return;
    }
    const operation = this.queues_[contentType][0];
    asserts.assert(operation, 'Spurious updateend event!');
    if (!operation) {
      return;
    }
    asserts.assert(!this.sourceBuffers_[contentType].updating, 'SourceBuffer should not be updating on updateend!');
    operation.p.resolve();
    this.popFromQueue_(contentType);
  }

  getTextDisplayer() {
    asserts.assert(this.textDisplayer_, 'TextDisplayer should only be null when this is destroyed');

    return this.textDisplayer_;
  }

  // TODO(sanfeng): TextDisplayer
  setTextDisplayer(textDisplayer: TextDisplayer) {
    const oldTextDisplayer = this.textDisplayer_;
    this.textDisplayer_ = textDisplayer;
    if (oldTextDisplayer) {
      textDisplayer.setTextVisibility(oldTextDisplayer.isTextVisible());
      oldTextDisplayer.destroy();
    }
    if (this.textEngine_) {
      this.textEngine_.setDisplayer(textDisplayer);
    }
  }

  setSegmentRelativeVttTiming(segmentRelativeVttTiming: boolean) {
    this.segmentRelativeVttTiming_ = segmentRelativeVttTiming;
  }

  /**
   * Apply platform-specific transformations to this segment to work around
   * issues in the platform.
   * @param segment
   * @param startTime
   * @param contentType
   * @param uri
   * @returns
   */
  private workAroundBrokenPlatforms_(
    segment: BufferSource,
    startTime: number | null,
    contentType: string,
    uri: string | null
  ) {
    const isInitSegment = startTime === null;
    const encryptionExpected = this.expectedEncryption_[contentType];

    // TODO: encryptionExpected

    return segment;
  }

  private change_(contentType: string, mimeType: string, transmuxer: Transmuxer | null = null) {
    if (contentType === ContentType.TEXT) {
      log.debug(`Change not supported for ${contentType}`);
      return;
    }
    log.debug(`Change Type: ${this.sourceBufferTypes_[contentType]} -> ${mimeType}`);
    if (Capabilities.isChangeTypeSupported()) {
      if (this.transmuxers_[contentType]) {
        this.transmuxers_[contentType].destroy();
        delete this.transmuxers_[contentType];
      }
      if (transmuxer) {
        this.transmuxers_[contentType] = transmuxer;
      }
      const type = this.addExtraFeaturesToMimeType_(mimeType);
      this.sourceBuffers_[contentType].changeType(type);
      this.sourceBufferTypes_[contentType] = mimeType;
    } else {
      log.debug('Change Type not supported');
    }
    this.onUpdateEnd_(contentType);
  }

  /**
   * Enqueue an operation to prepare the SourceBuffer to parse a potentially new
   * type or codec.
   * @param contentType
   * @param mimeType
   * @param transmuxer
   */
  changeType(contentType: string, mimeType: string, transmuxer: Transmuxer) {
    this.enqueueOperation_(contentType, () => this.change_(contentType, mimeType, transmuxer), null);
  }

  /**
   * Resets the MediaSource and re-adds source buffers due to codec mismatch
   * @param streamsByType
   */
  private async reset_(streamsByType: Map<string, Stream>) {
    this.reloadingMediaSource_ = true;
    this.needSplitMuxedContent_ = false;
    const currentTime = this.video_.currentTime;

    // When codec switching if the user is currently paused we don't want
    // to trigger a play when switching codec.
    // Playing can also end up in a paused state after a codec switch
    // so we need to remember the current states.
    const previousAutoPlayState = this.video_.autoplay;
    const previousPausedState = this.video_.paused;
    if (this.playbackHasBegun_) {
      // Only set autoplay to false if the video playback has already begun.
      // When a codec switch happens before playback has begun this can cause
      // autoplay not to work as expected.
      this.video_.autoplay = false;
    }

    try {
      this.eventManager_.removeAll();

      const cleanup = [];
      for (const contentType in this.transmuxers_) {
        cleanup.push(this.transmuxers_[contentType].destroy());
      }
      for (const contentType in this.queues_) {
        // Make a local copy of the queue and the first item.
        const q = this.queues_[contentType];
        const inProgress = q[0];

        // Drop everything else out of the original queue.
        this.queues_[contentType] = q.slice(0, 1);

        // We will wait for this item to complete/fail.
        if (inProgress) {
          // @ts-expect-error
          cleanup.push(inProgress.p.catch(Functional.noop));
        }

        // The rest will be rejected silently if possible.
        for (const item of q.slice(1)) {
          item.p.reject(Destroyer.destroyedError());
        }
      }

      for (const contentType in this.sourceBuffers_) {
        const sourceBuffer = this.sourceBuffers_[contentType];
        try {
          this.mediaSource_.removeSourceBuffer(sourceBuffer);
        } catch (e) {}
      }
      await Promise.all(cleanup);
      this.transmuxers_ = {};
      this.sourceBuffers_ = {};

      const previousDuration = this.mediaSource_.duration;
      this.mediaSourceOpen_ = new PublicPromise();
      this.mediaSource_ = this.createMediaSource(this.mediaSourceOpen_);
      await this.mediaSourceOpen_;
      if (!isNaN(previousDuration) && previousDuration) {
        this.mediaSource_.duration = previousDuration;
      } else if (!isNaN(this.lastDuration_) && this.lastDuration_) {
        this.mediaSource_.duration = this.lastDuration_;
      }

      const sourceBufferAdded = new PublicPromise();
      const sourceBuffers = this.mediaSource_.sourceBuffers;

      const totalOfBuffers = streamsByType.size;
      let numberOfSourceBufferAdded = 0;
      const onSourceBufferAdded = () => {
        numberOfSourceBufferAdded++;
        if (numberOfSourceBufferAdded === totalOfBuffers) {
          sourceBufferAdded.resolve();
          this.eventManager_.unlisten(sourceBuffers, 'addsourcebuffer', onSourceBufferAdded);
        }
      };

      this.eventManager_.listen(sourceBuffers, 'addsourcebuffer', onSourceBufferAdded);

      for (const contentType of streamsByType.keys()) {
        const stream = streamsByType.get(contentType);
        // eslint-disable-next-line no-await-in-loop
        await this.initSourceBuffer_(contentType, stream!, stream!.codecs);
        if (this.needSplitMuxedContent_) {
          this.queues_[ContentType.AUDIO] = [];
          this.queues_[ContentType.VIDEO] = [];
        } else {
          this.queues_[contentType] = [];
        }
      }
      // Fake a seek to catchup the playhead.
      this.video_.currentTime = currentTime;

      await sourceBufferAdded;
    } finally {
      this.reloadingMediaSource_ = false;
      this.destroyer_.ensureNotDestroyed();
      this.eventManager_.listenOnce(this.video_, 'canplaythrough', () => {
        // Don't use ensureNotDestroyed() from this event listener, because
        // that results in an uncaught exception.  Instead, just check the
        // flag.
        if (this.destroyer_.destroyed()) {
          return;
        }

        this.video_.autoplay = previousAutoPlayState;
        if (!previousPausedState) {
          this.video_.play();
        }
      });
    }
  }

  /**
   * Resets the Media Source
   * @param  streamsByType
   * @return
   */
  reset(streamsByType: Map<string, Stream>) {
    return this.enqueueBlockingOperation_(() => this.reset_(streamsByType));
  }

  /**
   * Codec switch if necessary, this will not resolve until the codec
   * switch is over.
   * @param contentType
   * @param mimeType
   * @param codecs
   * @param streamByType
   */
  private async codecSwitchIfNecessary_(
    contentType: string,
    mimeType: string,
    codecs: string,
    streamsByType: Map<string, Stream>
  ) {
    if (contentType == ContentType.TEXT) {
      return false;
    }
    const currentCodec = MimeUtils.getCodecBase(this.sourceBufferTypes_[contentType]);
    const currentBasicType = MimeUtils.getBasicType(this.sourceBufferTypes_[contentType]);
    let transmuxer: Transmuxer | null = null;
    let transmuxerMuxed = false;
    let newMimeType = MimeUtils.getFullType(mimeType, codecs);
    let needTransmux = this.config_.forceTransmux;

    if (
      !Capabilities.isTypeSupported(newMimeType) ||
      (!this.sequenceMode_ && MimeUtils.RAW_FORMATS.includes(newMimeType))
    ) {
      needTransmux = true;
    }

    if (needTransmux) {
      // TODO(sanfeng): TransmuxerEngine
    }

    const newCodec = MimeUtils.getCodecBase(MimeUtils.getCodecs(newMimeType));
    const newBasicType = MimeUtils.getBasicType(newMimeType);

    // Current/new codecs base and basic type match then no need to switch
    if (currentCodec === newCodec && currentBasicType === newBasicType) {
      return false;
    }

    let allowChangeType = true;

    if (this.needSplitMuxedContent_ || (transmuxerMuxed && transmuxer && !this.transmuxers_[contentType])) {
      allowChangeType = false;
    }

    if (
      allowChangeType &&
      this.config_.codecSwitchingStrategy === CodecSwitchingStrategy.SMOOTH &&
      Capabilities.isChangeTypeSupported()
    ) {
      // @ts-expect-error
      await this.changeType(contentType, newMimeType, transmuxer);
    } else {
      if (transmuxer) {
        // @ts-expect-error
        transmuxer.destroy();
      }
      await this.reset(streamsByType);
    }
    return true;
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
  enqueueOperation_(contentType: string, start: Function, uri: string | null) {
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
  private async enqueueBlockingOperation_(run: () => Promise<void> | void) {
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
   *  Returns true if it's necessary codec switch to load the new stream.
   * @param contentType
   * @param stream
   * @param refMimeType
   * @param refCodecs
   */
  private isCodecSwitchNecessary_(contentType: string, stream: Stream, refMimeType: string, refCodecs: string) {
    if (contentType == ContentType.TEXT) {
      return false;
    }

    const currentCodec = MimeUtils.getCodecBase(MimeUtils.getCodecs(this.sourceBufferTypes_[contentType]));
    const currentBasicType = MimeUtils.getBasicType(this.sourceBufferTypes_[contentType]);

    let newMimeType = MimeUtils.getFullType(refMimeType, refCodecs);
    let needTransmux = this.config_.forceTransmux;
    if (
      !Capabilities.isTypeSupported(newMimeType) ||
      (!this.sequenceMode_ && MimeUtils.RAW_FORMATS.includes(newMimeType))
    ) {
      needTransmux = true;
    }
    const newMimeTypeWithAllCodecs = MimeUtils.getFullTypeWithAllCodecs(refMimeType, refCodecs);
    // TODO(sanfeng): TransmuxerEngine
    // if (needTransmux) {
    //   const transmuxerPlugin = TransmuxerEngine.findTransmuxer(newMimeTypeWithAllCodecs);
    //   if (transmuxerPlugin) {
    //     const transmuxer = transmuxerPlugin();
    //     newMimeType = transmuxer.convertCodecs(contentType, newMimeTypeWithAllCodecs);
    //     transmuxer.destroy();
    //   }
    // }

    const newCodec = MimeUtils.getCodecBase(MimeUtils.getCodecs(newMimeType));
    const newBasicType = MimeUtils.getBasicType(newMimeType);

    return currentCodec !== newCodec || currentBasicType !== newBasicType;
  }

  /**
   * Returns true if it's necessary reset the media source to load the
   * new stream.
   * @param contentType
   * @param stream
   * @param refMimeType
   * @param refCodecs
   */
  isResetMediaSourceNecessary(contentType: string, stream: Stream, mimeType: string, codecs: string) {
    if (!this.isCodecSwitchNecessary_(contentType, stream, mimeType, codecs)) {
      return false;
    }

    return (
      this.config_.codecSwitchingStrategy !== CodecSwitchingStrategy.SMOOTH ||
      !Capabilities.isChangeTypeSupported() ||
      this.needSplitMuxedContent_
    );
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
