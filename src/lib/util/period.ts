import { Period, Stream, Variant } from '../../externs/shaka/manifest';
import { StreamDB } from '../../externs/shaka/offline';
import { asserts } from '../debug/asserts';
import { log } from '../debug/log';
import { DrmEngine } from '../media/drm_engtine';
import { MetaSegmentIndex, SegmentIndex } from '../media/segment_index';
import { ShakaError } from './error';
import { IReleasable } from './i_releasable';
import { LanguageUtils } from './language_utils';
import { ManifestParserUtils } from './manifest_parser_utils';
import { MimeUtils } from './mime_utils';

export class PeriodCombiner implements IReleasable {
  private variants_: Variant[] = [];
  private audioStreams_: Stream[] = [];
  private videoStreams_: Stream[] = [];
  private textStreams_: Stream[] = [];
  private imageStreams_: Stream[] = [];
  private multiTypeVariantsAllowed_ = false;
  private useStreamOnce_ = false;
  /**
   * The IDs of the periods we have already used to generate streams.
   * This helps us identify the periods which have been added when a live
   * stream is updated.
   *
   */
  private usedPeriodIds_ = new Set<string>();
  release(): void {
    const allStreams = this.audioStreams_.concat(this.videoStreams_, this.textStreams_, this.imageStreams_);

    for (const stream of allStreams) {
      if (stream.segmentIndex) {
        stream.segmentIndex.release();
      }
    }

    this.audioStreams_ = [];
    this.videoStreams_ = [];
    this.textStreams_ = [];
    this.imageStreams_ = [];
    this.variants_ = [];
  }

  getVariants() {
    return this.variants_;
  }

  getTextStreams() {
    // Return a copy of the array because makeTextStreamsForClosedCaptions
    // may make changes to the contents of the array. Those changes should not
    // propagate back to the PeriodCombiner.
    return this.textStreams_.slice();
  }

  getImageStreams() {
    return this.imageStreams_;
  }

  /**
   *  Returns an object that contains arrays of streams by type
   * @param periods
   * @param addDummy
   */
  private getStreamsPerPeriod_(periods: Period[], addDummy: boolean) {
    const audioStreamsPerPeriod = [];
    const videoStreamsPerPeriod = [];
    const textStreamsPerPeriod = [];
    const imageStreamsPerPeriod = [];
    const ContentType = ManifestParserUtils.ContentType;

    for (const period of periods) {
      const audioMap = new Map(period.audioStreams.map((s) => [PeriodCombiner.generateAudioKey_(s), s]));
      const videoMap = new Map(period.videoStreams.map((s) => [PeriodCombiner.generateVideoKey_(s), s]));
      const textMap = new Map(period.textStreams.map((s) => [PeriodCombiner.generateTextKey_(s), s]));
      const imageMap = new Map(period.imageStreams.map((s) => [PeriodCombiner.generateImageKey_(s), s]));

      // It's okay to have a period with no text or images, but our algorithm
      // fails on any period without matching streams.  So we add dummy streams
      // to each period.  Since we combine text streams by language and image
      // streams by resolution, we might need a dummy even in periods with these
      // streams already.
      if (addDummy) {
        const dummyText = PeriodCombiner.dummyStream_(ContentType.TEXT);
        textMap.set(PeriodCombiner.generateTextKey_(dummyText), dummyText);
        const dummyImage = PeriodCombiner.dummyStream_(ContentType.IMAGE);
        imageMap.set(PeriodCombiner.generateImageKey_(dummyImage), dummyImage);
      }

      audioStreamsPerPeriod.push(audioMap);
      videoStreamsPerPeriod.push(videoMap);
      textStreamsPerPeriod.push(textMap);
      imageStreamsPerPeriod.push(imageMap);
    }
    return {
      audioStreamsPerPeriod,
      videoStreamsPerPeriod,
      textStreamsPerPeriod,
      imageStreamsPerPeriod,
    };
  }

  /**
   *
   * @param periods
   * @param isDynamic
   * @param isPatchUpdate
   */
  async combinePeriods(periods: Period[], isDynamic: boolean, isPatchUpdate = false) {
    const ContentType = ManifestParserUtils.ContentType;
    // Optimization: for single-period VOD, do nothing.  This makes sure
    // single-period DASH content will be 100% accurately represented in the
    // output.
    if (!isDynamic && periods.length == 1) {
      // We need to filter out duplicates, so call getStreamsPerPeriod()
      // so it will do that by usage of Map.
      const { audioStreamsPerPeriod, videoStreamsPerPeriod, textStreamsPerPeriod, imageStreamsPerPeriod } =
        this.getStreamsPerPeriod_(periods, /* addDummy= */ false);
      this.audioStreams_ = Array.from(audioStreamsPerPeriod[0].values());
      this.videoStreams_ = Array.from(videoStreamsPerPeriod[0].values());
      this.textStreams_ = Array.from(textStreamsPerPeriod[0].values());
      this.imageStreams_ = Array.from(imageStreamsPerPeriod[0].values());
    } else {
      // How many periods we've seen before which are not included in this call.
      const periodsMissing = isPatchUpdate ? this.usedPeriodIds_.size : 0;
      // Find the first period we haven't seen before.  Tag all the periods we
      // see now as "used".
      // see now as "used".
      let firstNewPeriodIndex = -1;
      for (let i = 0; i < periods.length; i++) {
        const period = periods[i];
        if (this.usedPeriodIds_.has(period.id)) {
          // This isn't new.
        } else {
          // This one _is_ new.
          this.usedPeriodIds_.add(period.id);

          if (firstNewPeriodIndex == -1) {
            // And it's the _first_ new one.
            firstNewPeriodIndex = i;
          }
        }
      }
      if (firstNewPeriodIndex == -1) {
        // Nothing new? Nothing to do.
        return;
      }

      const { audioStreamsPerPeriod, videoStreamsPerPeriod, textStreamsPerPeriod, imageStreamsPerPeriod } =
        this.getStreamsPerPeriod_(periods, /* addDummy= */ true);
      await Promise.all([
        this.combine_(
          this.audioStreams_,
          audioStreamsPerPeriod,
          firstNewPeriodIndex,
          PeriodCombiner.cloneStream_,
          PeriodCombiner.concatenateStreams_,
          periodsMissing
        ),
        this.combine_(
          this.videoStreams_,
          videoStreamsPerPeriod,
          firstNewPeriodIndex,
          PeriodCombiner.cloneStream_,
          PeriodCombiner.concatenateStreams_,
          periodsMissing
        ),
        this.combine_(
          this.textStreams_,
          textStreamsPerPeriod,
          firstNewPeriodIndex,
          PeriodCombiner.cloneStream_,
          PeriodCombiner.concatenateStreams_,
          periodsMissing
        ),
        this.combine_(
          this.imageStreams_,
          imageStreamsPerPeriod,
          firstNewPeriodIndex,
          PeriodCombiner.cloneStream_,
          PeriodCombiner.concatenateStreams_,
          periodsMissing
        ),
      ]);
    }

    // Create variants for all audio/video combinations.
    let nextVariantId = 0;
    const variants: Variant[] = [];
    if (!this.videoStreams_.length || !this.audioStreams_.length) {
      // For audio-only or video-only content, just give each stream its own
      // variant.
      const streams = this.videoStreams_.length ? this.videoStreams_ : this.audioStreams_;
      for (const stream of streams) {
        const id = nextVariantId++;
        variants.push({
          id,
          language: stream.language,
          disabledUntilTime: 0,
          primary: stream.primary,
          audio: stream.type == ContentType.AUDIO ? stream : null,
          video: stream.type == ContentType.VIDEO ? stream : null,
          bandwidth: stream.bandwidth || 0,
          drmInfos: stream.drmInfos,
          allowedByApplication: true,
          allowedByKeySystem: true,
          decodingInfos: [],
        });
      }
    } else {
      for (const audio of this.audioStreams_) {
        for (const video of this.videoStreams_) {
          const commonDrmInfos = DrmEngine.getCommonDrmInfos(audio.drmInfos, video.drmInfos);

          if (audio.drmInfos.length && video.drmInfos.length && !commonDrmInfos.length) {
            log.warning('Incompatible DRM in audio & video, skipping variant creation.', audio, video);
            continue;
          }

          const id = nextVariantId++;
          variants.push({
            id,
            language: audio.language,
            disabledUntilTime: 0,
            primary: audio.primary,
            audio,
            video,
            bandwidth: (audio.bandwidth || 0) + (video.bandwidth || 0),
            drmInfos: commonDrmInfos,
            allowedByApplication: true,
            allowedByKeySystem: true,
            decodingInfos: [],
          });
        }
      }
    }
    this.variants_ = variants;
  }

  /**
   * Stitch together DB streams across periods, taking a mix of stream types.
   * The offline database does not separate these by type.
   *
   * Unlike the DASH case, this does not need to maintain any state for manifest
   * updates.
   *
   * @param streamDbsPerPeriod
   * @return
   */
  static async combineDbStreams(streamDbsPerPeriod: StreamDB[][]): Promise<StreamDB[]> {
    const ContentType = ManifestParserUtils.ContentType;
    // Optimization: for single-period content, do nothing.  This makes sure
    // single-period DASH or any HLS content stored offline will be 100%
    // accurately represented in the output.
    if (streamDbsPerPeriod.length == 1) {
      return streamDbsPerPeriod[0];
    }

    const audioStreamDbsPerPeriod = streamDbsPerPeriod.map(
      (streams) =>
        new Map(
          streams.filter((s) => s.type === ContentType.AUDIO).map((s) => [PeriodCombiner.generateAudioKey_(s), s])
        )
    );
    const videoStreamDbsPerPeriod = streamDbsPerPeriod.map(
      (streams) =>
        new Map(
          streams.filter((s) => s.type === ContentType.VIDEO).map((s) => [PeriodCombiner.generateVideoKey_(s), s])
        )
    );
    const textStreamDbsPerPeriod = streamDbsPerPeriod.map(
      (streams) =>
        new Map(streams.filter((s) => s.type === ContentType.TEXT).map((s) => [PeriodCombiner.generateTextKey_(s), s]))
    );
    const imageStreamDbsPerPeriod = streamDbsPerPeriod.map(
      (streams) =>
        new Map(
          streams.filter((s) => s.type === ContentType.IMAGE).map((s) => [PeriodCombiner.generateImageKey_(s), s])
        )
    );
    // It's okay to have a period with no text or images, but our algorithm
    // fails on any period without matching streams.  So we add dummy streams to
    // each period.  Since we combine text streams by language and image streams
    // by resolution, we might need a dummy even in periods with these streams
    // already.
    for (const textStreams of textStreamDbsPerPeriod) {
      const dummy = PeriodCombiner.dummyStreamDB_(ContentType.TEXT);
      textStreams.set(PeriodCombiner.generateTextKey_(dummy), dummy);
    }
    for (const imageStreams of imageStreamDbsPerPeriod) {
      const dummy = PeriodCombiner.dummyStreamDB_(ContentType.IMAGE);
      imageStreams.set(PeriodCombiner.generateImageKey_(dummy), dummy);
    }

    const periodCombiner = new PeriodCombiner();

    const combinedAudioStreamDbs = await periodCombiner.combine_(
      /* outputStreams= */ [],
      audioStreamDbsPerPeriod,
      /* firstNewPeriodIndex= */ 0,
      PeriodCombiner.cloneStreamDB_,
      PeriodCombiner.concatenateStreamDBs_,
      /* periodsMissing= */ 0
    );

    const combinedVideoStreamDbs = await periodCombiner.combine_(
      /* outputStreams= */ [],
      videoStreamDbsPerPeriod,
      /* firstNewPeriodIndex= */ 0,
      PeriodCombiner.cloneStreamDB_,
      PeriodCombiner.concatenateStreamDBs_,
      /* periodsMissing= */ 0
    );

    const combinedTextStreamDbs = await periodCombiner.combine_(
      /* outputStreams= */ [],
      textStreamDbsPerPeriod,
      /* firstNewPeriodIndex= */ 0,
      PeriodCombiner.cloneStreamDB_,
      PeriodCombiner.concatenateStreamDBs_,
      /* periodsMissing= */ 0
    );

    const combinedImageStreamDbs = await periodCombiner.combine_(
      /* outputStreams= */ [],
      imageStreamDbsPerPeriod,
      /* firstNewPeriodIndex= */ 0,
      PeriodCombiner.cloneStreamDB_,
      PeriodCombiner.concatenateStreamDBs_,
      /* periodsMissing= */ 0
    );

    // Recreate variantIds from scratch in the output.
    // HLS content is always single-period, so the early return at the top of
    // this method would catch all HLS content.  DASH content stored with v3.0
    // will already be flattened before storage.  Therefore the only content
    // that reaches this point is multi-period DASH content stored before v3.0.
    // Such content always had variants generated from all combinations of audio
    // and video, so we can simply do that now without loss of correctness.
    let nextVariantId = 0;
    if (!combinedVideoStreamDbs.length || !combinedAudioStreamDbs.length) {
      // For audio-only or video-only content, just give each stream its own
      // variant ID.
      const combinedStreamDbs = combinedVideoStreamDbs.concat(combinedAudioStreamDbs);
      for (const stream of combinedStreamDbs) {
        stream.variantIds = [nextVariantId++];
      }
    } else {
      for (const audio of combinedAudioStreamDbs) {
        for (const video of combinedVideoStreamDbs) {
          const id = nextVariantId++;
          video.variantIds.push(id);
          audio.variantIds.push(id);
        }
      }
    }

    return combinedVideoStreamDbs
      .concat(combinedAudioStreamDbs)
      .concat(combinedTextStreamDbs)
      .concat(combinedImageStreamDbs);
  }

  /**
   * Create a dummy StreamDB to fill in periods that are missing a certain type,
   * to avoid failing the general flattening algorithm.  This won't be used for
   * audio or video, since those are strictly required in all periods if they
   * exist in any period.
   *
   * @param type
   * @return
   * @private
   */
  static dummyStreamDB_(type: string): StreamDB {
    return {
      id: 0,
      originalId: '',
      groupId: null,
      primary: false,
      type,
      mimeType: '',
      codecs: '',
      language: '',
      originalLanguage: null,
      label: null,
      width: null,
      height: null,
      encrypted: false,
      keyIds: new Set(),
      segments: [],
      variantIds: [],
      roles: [],
      forced: false,
      channelsCount: null,
      audioSamplingRate: null,
      spatialAudio: false,
      closedCaptions: null,
      external: false,
      fastSwitching: false,
    };
  }

  /**
   * Combine input Streams per period into flat output Streams.
   * Templatized to handle both DASH Streams and offline StreamDBs.
   * @param outputStreams A list of existing output streams, to
   *   facilitate updates for live DASH content.  Will be modified and returned.
   * @param streamsPerPeriod A list of maps of Streams
   *   from each period.
   * @param firstNewPeriodIndex An index into streamsPerPeriod which
   *   represents the first new period that hasn't been processed yet.
   * @param clone Make a clone of an input stream.
   * @param concatenateStreams_ Concatenate the second stream onto the end
   *   of the first.
   * @param periodsMissing  The number of periods missing
   * The same array passed to outputStreams,
   *   modified to include any newly-created streams.
   *
   */
  private async combine_<T extends Stream | StreamDB>(
    outputStreams: T[],
    streamsPerPeriod: Map<string, T>[],
    firstNewPeriodIndex: number,
    clone: (stream: T) => T,
    concat: (output: T, input: T) => void,
    periodsMissing: number
  ): Promise<T[]> {
    const unusedStreamsPerPeriod: Array<Set<T>> = [];

    for (let i = 0; i < streamsPerPeriod.length; i++) {
      if (i >= firstNewPeriodIndex) {
        // This periods streams are all new.
        unusedStreamsPerPeriod.push(new Set(streamsPerPeriod[i].values()));
      } else {
        // This period's streams have all been used already.
        unusedStreamsPerPeriod.push(new Set());
      }
    }

    // First, extend all existing output Streams into the new periods.
    for (const outputStream of outputStreams) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await this.extendExistingOutputStream_(
        outputStream as Stream,
        streamsPerPeriod,
        firstNewPeriodIndex,
        concat,
        unusedStreamsPerPeriod,
        periodsMissing
      );
      if (!ok) {
        // This output Stream was not properly extended to include streams from
        // the new period.  This is likely a bug in our algorithm, so throw an
        // error.
        throw new ShakaError(
          ShakaError.Severity.CRITICAL,
          ShakaError.Category.MANIFEST,
          ShakaError.Code.PERIOD_FLATTENING_FAILED
        );
      }

      // This output stream is now complete with content from all known
      // periods.
    } // for (const outputStream of outputStreams)

    for (const unusedStreams of unusedStreamsPerPeriod) {
      for (const stream of unusedStreams) {
        // Create a new output stream which includes this input stream.
        const outputStream = this.createNewOutputStream_(
          stream,
          streamsPerPeriod,
          clone,
          concat,
          unusedStreamsPerPeriod
        );
        if (outputStream) {
          outputStreams.push(outputStream);
        } else {
          // This is not a stream we can build output from, but it may become
          // part of another output based on another period's stream.
        }
      } // for (const stream of unusedStreams)
    } // for (const unusedStreams of unusedStreamsPerPeriod)

    for (const unusedStreams of unusedStreamsPerPeriod) {
      for (const stream of unusedStreams) {
        if (PeriodCombiner.isDummy_(stream)) {
          // This is one of our dummy streams, so ignore it.  We may not use
          // them all, and that's fine.
          continue;
        }
        // If this stream has a different codec/MIME than any other stream,
        // then we can't play it.
        const hasCodec = outputStreams.some((s) => {
          return this.areAVStreamsCompatible_(stream, s);
        });
        if (!hasCodec) {
          continue;
        }

        // Any other unused stream is likely a bug in our algorithm, so throw
        // an error.
        log.error('Unused stream in period-flattening!', stream, outputStreams);
        throw new ShakaError(
          ShakaError.Severity.CRITICAL,
          ShakaError.Category.MANIFEST,
          ShakaError.Code.PERIOD_FLATTENING_FAILED
        );
      }
    }

    return outputStreams;
  }

  /**
   * Create a new output Stream based on a particular input Stream.  Locates
   * matching Streams in all other periods and combines them into an output
   * Stream.
   * Templatized to handle both DASH Streams and offline StreamDBs.
   *
   * @param {T} stream An input stream on which to base the output stream.
   * @param {!Array<!Map<string, T>>} streamsPerPeriod A list of maps of Streams
   *   from each period.
   * @param {function(T):T} clone Make a clone of an input stream.
   * @param {function(T, T)} concat Concatenate the second stream onto the end
   *   of the first.
   * @param {!Array.<!Set.<T>>} unusedStreamsPerPeriod An array of sets of
   *   unused streams from each period.
   *
   * @return {?T} A newly-created output Stream, or null if matches
   *   could not be found.`
   *
   * @template T
   * Accepts either a StreamDB or Stream type.
   *
   * @private
   */
  createNewOutputStream_<T extends Stream | StreamDB>(
    stream: T,
    streamsPerPeriod: Array<Map<string, T>>,
    clone: (stream: T) => T,
    concat: (output: T, input: T) => void,
    unusedStreamsPerPeriod: Array<Set<T>>
  ) {
    // Check do we want to create output stream from dummy stream
    // and if so, return quickly.
    if (PeriodCombiner.isDummy_(stream)) {
      return null;
    }
    // Start by cloning the stream without segments, key IDs, etc.
    const outputStream = clone(stream);

    // Find best-matching streams in all periods.
    this.findMatchesInAllPeriods_(streamsPerPeriod, outputStream);

    // This only exists where T == Stream.
    if ((outputStream as Stream).createSegmentIndex) {
      // Override the createSegmentIndex function of the outputStream.
      (outputStream as Stream).createSegmentIndex = async () => {
        if (!(outputStream as Stream).segmentIndex) {
          (outputStream as Stream).segmentIndex = new MetaSegmentIndex();
          await PeriodCombiner.extendOutputSegmentIndex_(outputStream as Stream, /* firstNewPeriodIndex= */ 0);
        }
      };
      // For T == Stream, we need to create all the per-period segment indexes
      // in advance.  concat() will add them to the output's MetaSegmentIndex.
    }

    if (!(outputStream as Stream).matchedStreams || !(outputStream as Stream).matchedStreams!.length) {
      // This is not a stream we can build output from, but it may become part
      // of another output based on another period's stream.
      return null;
    }
    PeriodCombiner.extendOutputStream_(
      outputStream as Stream,
      /* firstNewPeriodIndex= */ 0,
      concat as any,
      unusedStreamsPerPeriod as any,
      /* periodsMissing= */ 0
    );

    return outputStream;
  }

  /**
   *
   * @param outputStream An existing output stream which needs to be
   *   extended into new periods.
   * @param streamsPerPeriod A list of maps of Streams
   *   from each period.
   * @param firstNewPeriodIndex An index into streamsPerPeriod which
   *   represents the first new period that hasn't been processed yet.
   * @param concat Concatenate the second stream onto the end
   *   of the first.
   * @param unusedStreamsPerPeriod  An array of sets of
   *   unused streams from each period.
   * @param periodsMissing How many periods are missing in this update.
   */
  async extendExistingOutputStream_<T extends Stream | StreamDB>(
    outputStream: Stream,
    streamsPerPeriod: Map<string, T>[],
    firstNewPeriodIndex: number,
    concat: (output: T, input: T) => void,
    unusedStreamsPerPeriod: Set<T>[],
    periodsMissing: number
  ): Promise<boolean> {
    this.findMatchesInAllPeriods_(streamsPerPeriod, outputStream as T, periodsMissing > 0);
    asserts.assert((outputStream as Stream).createSegmentIndex, 'outputStream should be a Stream type!');

    if (!outputStream.matchedStreams) {
      // We were unable to extend this output stream.
      log.error('No matches extending output stream!', outputStream, streamsPerPeriod);
      return false;
    }

    // We need to create all the per-period segment indexes and append them to
    // the output's MetaSegmentIndex.
    if (outputStream.segmentIndex) {
      await PeriodCombiner.extendOutputSegmentIndex_(outputStream, firstNewPeriodIndex + periodsMissing);
    }

    PeriodCombiner.extendOutputStream_(
      outputStream,
      firstNewPeriodIndex,
      concat as any,
      unusedStreamsPerPeriod as any,
      periodsMissing
    );
    return true;
  }
  /**
   *
   * @param outputStream
   * @param firstNewPeriodIndex
   * @param concat
   * @param unusedStreamsPerPeriod
   * @param periodsMissing
   */
  private static extendOutputStream_(
    outputStream: Stream,
    firstNewPeriodIndex: number,
    concat: (output: Stream, input: Stream) => void,
    unusedStreamsPerPeriod: Set<Stream>[],
    periodsMissing: number
  ) {
    const ContentType = ManifestParserUtils.ContentType;

    const matches = outputStream.matchedStreams!;

    // Assure the compiler that matches didn't become null during the async
    // operation before.
    asserts.assert(outputStream.matchedStreams, 'matchedStreams should be non-null');

    // Concatenate the new matches onto the stream, starting at the first new
    // period.
    const start = firstNewPeriodIndex + periodsMissing;
    for (let i = start; i < matches.length; i++) {
      const match = matches[i];
      concat(outputStream, match);

      // We only consider an audio stream "used" if its language is related to
      // the output language.  There are scenarios where we want to generate
      // separate tracks for each language, even when we are forced to connect
      // unrelated languages across periods.
      let used = true;
      if (outputStream.type == ContentType.AUDIO) {
        const relatedness = LanguageUtils.relatedness(outputStream.language, match.language);
        if (relatedness == 0) {
          used = false;
        }
      }

      if (used) {
        unusedStreamsPerPeriod[i - periodsMissing].delete(match);
        // Add the full mimetypes to the stream.
        if (match.fullMimeTypes) {
          for (const fullMimeType of match.fullMimeTypes.values()) {
            outputStream.fullMimeTypes.add(fullMimeType);
          }
        }
      }
    }
  }

  /**
   * Creates the segment indexes for an array of input streams, and append them
   * to the output stream's segment index.
   *
   * @param {shaka.extern.Stream} outputStream
   * @param {number} firstNewPeriodIndex An index into streamsPerPeriod which
   *   represents the first new period that hasn't been processed yet.
   * @private
   */
  private static async extendOutputSegmentIndex_(outputStream: Stream, firstNewPeriodIndex: number) {
    const operations = [];
    const streams = outputStream.matchedStreams!;
    asserts.assert(streams, 'matched streams should be valid');

    for (const stream of streams!) {
      operations.push(stream.createSegmentIndex());
      if (stream.trickModeVideo && !stream.trickModeVideo.segmentIndex) {
        operations.push(stream.trickModeVideo.createSegmentIndex());
      }
    }
    await Promise.all(operations);

    // Concatenate the new matches onto the stream, starting at the first new
    // period.
    // Satisfy the compiler about the type.
    // Also checks if the segmentIndex is still valid after the async
    // operations, to make sure we stop if the active stream has changed.
    if (outputStream.segmentIndex instanceof MetaSegmentIndex) {
      for (let i = firstNewPeriodIndex; i < streams.length; i++) {
        const match = streams[i];
        asserts.assert(match.segmentIndex, 'stream should have a segmentIndex.');
        if (match.segmentIndex) {
          outputStream.segmentIndex.appendSegmentIndex(match.segmentIndex);
        }
      }
    }
  }

  /**
   * Finds streams in all periods which match the output stream.
   * @param streamsPerPeriod
   * @param outputStream
   * @param shouldAppend
   */
  findMatchesInAllPeriods_<T extends Stream | StreamDB>(
    streamsPerPeriod: Map<string, T>[],
    outputStream: T,
    shouldAppend: boolean = false
  ) {
    const matches: T[] = shouldAppend ? ((outputStream as Stream).matchedStreams! as any) : [];
    for (const streams of streamsPerPeriod) {
      const match = this.findBestMatchInPeriod_(streams, outputStream);
      if (!match) {
        return;
      }
      matches.push(match);
    }
    (outputStream as Stream).matchedStreams = matches as any;
  }

  /**
   *  Find the best match for the output stream.
   * @param streams
   * @param outputStream
   */
  findBestMatchInPeriod_<T extends Stream | StreamDB>(streams: Map<string, T>, outputStream: T): T {
    const getKey = {
      audio: PeriodCombiner.generateAudioKey_,
      video: PeriodCombiner.generateVideoKey_,
      text: PeriodCombiner.generateTextKey_,
      image: PeriodCombiner.generateImageKey_,
    }[outputStream.type];
    let best: T = null as unknown as T;
    const key = getKey!(outputStream);
    if (streams.has(key)) {
      // We've found exact match by hashing.
      best = streams.get(key)!;
    } else {
      // We haven't found exact match, try to find the best one via
      // linear search.
      const areCompatible = {
        audio: (os: Stream | StreamDB, s: Stream | StreamDB) => this.areAVStreamsCompatible_(os, s),
        video: (os: Stream | StreamDB, s: Stream | StreamDB) => this.areAVStreamsCompatible_(os, s),
        text: PeriodCombiner.areTextStreamsCompatible_,
        image: PeriodCombiner.areImageStreamsCompatible_,
      }[outputStream.type];
      const isBetterMatch = {
        audio: PeriodCombiner.isAudioStreamBetterMatch_,
        video: PeriodCombiner.isVideoStreamBetterMatch_,
        text: PeriodCombiner.isTextStreamBetterMatch_,
        image: PeriodCombiner.isImageStreamBetterMatch_,
      }[outputStream.type];
      for (const stream of streams.values()) {
        if (!areCompatible!(outputStream, stream)) {
          continue;
        }

        if (outputStream.fastSwitching != stream.fastSwitching) {
          continue;
        }

        if (!best || isBetterMatch!(outputStream, best, stream)) {
          best = stream;
        }
      }
    }
    // Remove just found stream if configured to, so possible future linear
    // searches can be faster.
    if (this.useStreamOnce_ && !PeriodCombiner.isDummy_(best)) {
      streams.delete(getKey!(best));
    }

    return best!;
  }
  /**
   * @param {T} stream
   * @return {boolean}
   * @template T
   * Accepts either a StreamDB or Stream type.
   * @private
   */
  static isDummy_<T extends Stream | StreamDB>(stream: T) {
    const ContentType = ManifestParserUtils.ContentType;
    switch (stream.type) {
      case ContentType.TEXT:
        return !stream.language;
      case ContentType.IMAGE:
        return !stream.tilesLayout;
      default:
        return false;
    }
  }

  /**
   *
   * @param outputStream An audio output stream
   * @param best  The best match so far for this period
   * @param candidate A candidate stream which might be better
   * @returns True if the candidate is a better match
   */
  static isAudioStreamBetterMatch_<T extends Stream | StreamDB>(outputStream: T, best: T, candidate: T) {
    const { BETTER, EQUAL, WORSE } = PeriodCombinerBetterOrWorse;

    const bestIsExact = PeriodCombiner.areAVStreamsExactMatch_(outputStream, best);
    const candidateIsExact = PeriodCombiner.areAVStreamsExactMatch_(outputStream, candidate);
    if (bestIsExact && !candidateIsExact) {
      return false;
    }
    if (!bestIsExact && candidateIsExact) {
      return true;
    }

    // The most important thing is language.  In some cases, we will accept a
    // different language across periods when we must.
    const bestRelatedness = LanguageUtils.relatedness(outputStream.language, best.language);
    const candidateRelatedness = LanguageUtils.relatedness(outputStream.language, candidate.language);

    if (candidateRelatedness > bestRelatedness) {
      return true;
    }
    if (candidateRelatedness < bestRelatedness) {
      return false;
    }

    // If language-based differences haven't decided this, look at labels.
    // If available options differ, look does any matches with output stream.
    if (best.label !== candidate.label) {
      if (outputStream.label === best.label) {
        return false;
      }
      if (outputStream.label === candidate.label) {
        return true;
      }
    }

    // If label-based differences haven't decided this, look at roles.  If
    // the candidate has more roles in common with the output, upgrade to the
    // candidate.
    if (outputStream.roles.length) {
      const bestRoleMatches = best.roles.filter((role) => outputStream.roles.includes(role));
      const candidateRoleMatches = candidate.roles.filter((role) => outputStream.roles.includes(role));
      if (candidateRoleMatches.length > bestRoleMatches.length) {
        return true;
      } else if (candidateRoleMatches.length < bestRoleMatches.length) {
        return false;
      } else {
        // Both streams have the same role overlap with the outputStream
        // If this is the case, choose the stream with the fewer roles overall.
        // Streams that match best together tend to be streams with the same
        // roles, e g stream1 with roles [r1, r2] is likely a better match
        // for stream2 with roles [r1, r2] vs stream3 with roles
        // [r1, r2, r3, r4].
        // If we match stream1 with stream3 due to the same role overlap,
        // stream2 is likely to be left unmatched and error out later.
        // See https://github.com/shaka-project/shaka-player/issues/2542 for
        // more details.
        return candidate.roles.length < best.roles.length;
      }
    } else if (!candidate.roles.length && best.roles.length) {
      // If outputStream has no roles, and only one of the streams has no roles,
      // choose the one with no roles.
      return true;
    } else if (candidate.roles.length && !best.roles.length) {
      return false;
    }

    // If the language doesn't match, but the candidate is the "primary"
    // language, then that should be preferred as a fallback.
    if (!best.primary && candidate.primary) {
      return true;
    }
    if (best.primary && !candidate.primary) {
      return false;
    }

    // If language-based and role-based features are equivalent, take the audio
    // with the closes channel count to the output.
    const channelsBetterOrWorse = PeriodCombiner.compareClosestPreferLower(
      outputStream.channelsCount!,
      best.channelsCount!,
      candidate.channelsCount!
    );
    if (channelsBetterOrWorse == BETTER) {
      return true;
    } else if (channelsBetterOrWorse == WORSE) {
      return false;
    }

    // If channels are equal, take the closest sample rate to the output.
    const sampleRateBetterOrWorse = PeriodCombiner.compareClosestPreferLower(
      outputStream.audioSamplingRate!,
      best.audioSamplingRate!,
      candidate.audioSamplingRate!
    );
    if (sampleRateBetterOrWorse == BETTER) {
      return true;
    } else if (sampleRateBetterOrWorse == WORSE) {
      return false;
    }

    if ((outputStream as Stream).bandwidth) {
      // Take the audio with the closest bandwidth to the output.
      const bandwidthBetterOrWorse = PeriodCombiner.compareClosestPreferMinimalAbsDiff_(
        (outputStream as Stream).bandwidth!,
        (best as Stream).bandwidth!,
        (candidate as Stream).bandwidth!
      );
      if (bandwidthBetterOrWorse == BETTER) {
        return true;
      } else if (bandwidthBetterOrWorse == WORSE) {
        return false;
      }
    }

    // If the result of each comparison was inconclusive, default to false.
    return false;
  }

  /**
   * @param {T} outputStream A video output stream
   * @param {T} best The best match so far for this period
   * @param {T} candidate A candidate stream which might be better
   * @return {boolean} True if the candidate is a better match
   *
   * @template T
   * Accepts either a StreamDB or Stream type.
   *
   * @private
   */
  static isVideoStreamBetterMatch_<T extends Stream | StreamDB>(outputStream: T, best: T, candidate: T) {
    const { BETTER, EQUAL, WORSE } = PeriodCombinerBetterOrWorse;

    // An exact match is better than a non-exact match.
    const bestIsExact = PeriodCombiner.areAVStreamsExactMatch_(outputStream, best);
    const candidateIsExact = PeriodCombiner.areAVStreamsExactMatch_(outputStream, candidate);
    if (bestIsExact && !candidateIsExact) {
      return false;
    }
    if (!bestIsExact && candidateIsExact) {
      return true;
    }

    // Take the video with the closest resolution to the output.
    const resolutionBetterOrWorse = PeriodCombiner.compareClosestPreferLower(
      outputStream.width! * outputStream.height!,
      best.width! * best.height!,
      candidate.width! * candidate.height!
    );
    if (resolutionBetterOrWorse == BETTER) {
      return true;
    } else if (resolutionBetterOrWorse == WORSE) {
      return false;
    }

    // We may not know the frame rate for the content, in which case this gets
    // skipped.
    if (outputStream.frameRate) {
      // Take the video with the closest frame rate to the output.
      const frameRateBetterOrWorse = PeriodCombiner.compareClosestPreferLower(
        outputStream.frameRate,
        best.frameRate!,
        candidate.frameRate!
      );
      if (frameRateBetterOrWorse == BETTER) {
        return true;
      } else if (frameRateBetterOrWorse == WORSE) {
        return false;
      }
    }

    if ((outputStream as Stream).bandwidth) {
      // Take the video with the closest bandwidth to the output.
      const bandwidthBetterOrWorse = PeriodCombiner.compareClosestPreferMinimalAbsDiff_(
        (outputStream as Stream).bandwidth!,
        (best as Stream).bandwidth!,
        (candidate as Stream).bandwidth!
      );
      if (bandwidthBetterOrWorse == BETTER) {
        return true;
      } else if (bandwidthBetterOrWorse == WORSE) {
        return false;
      }
    }

    // If the result of each comparison was inconclusive, default to false.
    return false;
  }

  /**
   * @param {T} outputStream A text output stream
   * @param {T} best The best match so far for this period
   * @param {T} candidate A candidate stream which might be better
   * @return {boolean} True if the candidate is a better match
   *
   * @template T
   * Accepts either a StreamDB or Stream type.
   *
   * @private
   */
  static isTextStreamBetterMatch_<T extends Stream | StreamDB>(outputStream: T, best: T, candidate: T) {
    // The most important thing is language.  In some cases, we will accept a
    // different language across periods when we must.
    const bestRelatedness = LanguageUtils.relatedness(outputStream.language, best.language);
    const candidateRelatedness = LanguageUtils.relatedness(outputStream.language, candidate.language);

    if (candidateRelatedness > bestRelatedness) {
      return true;
    }
    if (candidateRelatedness < bestRelatedness) {
      return false;
    }

    // If the language doesn't match, but the candidate is the "primary"
    // language, then that should be preferred as a fallback.
    if (!best.primary && candidate.primary) {
      return true;
    }
    if (best.primary && !candidate.primary) {
      return false;
    }

    // If language-based differences haven't decided this, look at labels.
    // If available options differ, look does any matches with output stream.
    if (best.label !== candidate.label) {
      if (outputStream.label === best.label) {
        return false;
      }
      if (outputStream.label === candidate.label) {
        return true;
      }
    }

    // If the candidate has more roles in common with the output, upgrade to the
    // candidate.
    if (outputStream.roles.length) {
      const bestRoleMatches = best.roles.filter((role) => outputStream.roles.includes(role));
      const candidateRoleMatches = candidate.roles.filter((role) => outputStream.roles.includes(role));
      if (candidateRoleMatches.length > bestRoleMatches.length) {
        return true;
      }
      if (candidateRoleMatches.length < bestRoleMatches.length) {
        return false;
      }
    } else if (!candidate.roles.length && best.roles.length) {
      // If outputStream has no roles, and only one of the streams has no roles,
      // choose the one with no roles.
      return true;
    } else if (candidate.roles.length && !best.roles.length) {
      return false;
    }

    // If the candidate has the same MIME type and codec, upgrade to the
    // candidate.  It's not required that text streams use the same format
    // across periods, but it's a helpful signal.  Some content in our demo app
    // contains the same languages repeated with two different text formats in
    // each period.  This condition ensures that all text streams are used.
    // Otherwise, we wind up with some one stream of each language left unused,
    // triggering a failure.
    if (
      candidate.mimeType == outputStream.mimeType &&
      candidate.codecs == outputStream.codecs &&
      (best.mimeType != outputStream.mimeType || best.codecs != outputStream.codecs)
    ) {
      return true;
    }

    // If the result of each comparison was inconclusive, default to false.
    return false;
  }

  /**
   * @param {T} outputStream A image output stream
   * @param {T} best The best match so far for this period
   * @param {T} candidate A candidate stream which might be better
   * @return {boolean} True if the candidate is a better match
   *
   * @template T
   * Accepts either a StreamDB or Stream type.
   *
   * @private
   */
  static isImageStreamBetterMatch_<T extends Stream | StreamDB>(outputStream: T, best: T, candidate: T) {
    const { BETTER, EQUAL, WORSE } = PeriodCombinerBetterOrWorse;

    // Take the image with the closest resolution to the output.
    const resolutionBetterOrWorse = PeriodCombiner.compareClosestPreferLower(
      outputStream.width! * outputStream.height!,
      best.width! * best.height!,
      candidate.width! * candidate.height!
    );
    if (resolutionBetterOrWorse == BETTER) {
      return true;
    } else if (resolutionBetterOrWorse == WORSE) {
      return false;
    }

    // If the result of each comparison was inconclusive, default to false.
    return false;
  }

  /**
   * Compare the best value so far with the candidate value and the output
   * value.  Decide if the candidate is better, equal, or worse than the best
   * so far.  Any value less than or equal to the output is preferred over a
   * larger value, and closer to the output is better than farther.
   *
   * This provides us a generic way to choose things that should match as
   * closely as possible, like resolution, frame rate, audio channels, or
   * sample rate.  If we have to go higher to make a match, we will.  But if
   * the user selects 480p, for example, we don't want to surprise them with
   * 720p and waste bandwidth if there's another choice available to us.
   *
   * @param {number} outputValue
   * @param {number} bestValue
   * @param {number} candidateValue
   * @return
   */
  static compareClosestPreferLower(outputValue: number, bestValue: number, candidateValue: number) {
    const { BETTER, EQUAL, WORSE } = PeriodCombinerBetterOrWorse;
    // If one is the exact match for the output value, and the other isn't,
    // prefer the one that is the exact match.
    if (bestValue == outputValue && outputValue != candidateValue) {
      return WORSE;
    } else if (candidateValue == outputValue && outputValue != bestValue) {
      return BETTER;
    }

    if (bestValue > outputValue) {
      if (candidateValue <= outputValue) {
        // Any smaller-or-equal-to-output value is preferable to a
        // bigger-than-output value.
        return BETTER;
      }

      // Both "best" and "candidate" are greater than the output.  Take
      // whichever is closer.
      if (candidateValue - outputValue < bestValue - outputValue) {
        return BETTER;
      } else if (candidateValue - outputValue > bestValue - outputValue) {
        return WORSE;
      }
    } else {
      // The "best" so far is less than or equal to the output.  If the
      // candidate is bigger than the output, we don't want it.
      if (candidateValue > outputValue) {
        return WORSE;
      }

      // Both "best" and "candidate" are less than or equal to the output.
      // Take whichever is closer.
      if (outputValue - candidateValue < outputValue - bestValue) {
        return BETTER;
      } else if (outputValue - candidateValue > outputValue - bestValue) {
        return WORSE;
      }
    }

    return EQUAL;
  }

  /**
   * @param {number} outputValue
   * @param {number} bestValue
   * @param {number} candidateValue
   * @return
   * @private
   */
  static compareClosestPreferMinimalAbsDiff_(outputValue: number, bestValue: number, candidateValue: number) {
    const { BETTER, EQUAL, WORSE } = PeriodCombinerBetterOrWorse;

    const absDiffBest = Math.abs(outputValue - bestValue);
    const absDiffCandidate = Math.abs(outputValue - candidateValue);
    if (absDiffCandidate < absDiffBest) {
      return BETTER;
    } else if (absDiffBest < absDiffCandidate) {
      return WORSE;
    }

    return EQUAL;
  }

  /**
   * @param outputStream A text output stream
   * @param candidate A candidate stream to be combined with the output
   * @return True if the candidate could be combined with the
   *   output
   */
  static areTextStreamsCompatible_<T extends Stream | StreamDB>(outputStream: T, candidate: T): boolean {
    // For text, we don't care about MIME type or codec.  We can always switch
    // between text types.

    // If the candidate is a dummy, then it is compatible, and we could use it
    // if nothing else matches.
    if (!candidate.language) {
      return true;
    }

    // Forced subtitles should be treated as unique streams
    if (outputStream.forced !== candidate.forced) {
      return false;
    }

    const languageRelatedness = LanguageUtils.relatedness(outputStream.language, candidate.language);

    // We will strictly avoid combining text across languages or "kinds"
    // (caption vs subtitle).
    if (languageRelatedness == 0 || candidate.kind != outputStream.kind) {
      return false;
    }

    return true;
  }

  /**
   * @param  outputStream A image output stream
   * @param  candidate A candidate stream to be combined with the output
   * @return  True if the candidate could be combined with the
   *   output
   *
   * @private
   */
  private static areImageStreamsCompatible_<T extends Stream | StreamDB>(outputStream: T, candidate: T) {
    // For image, we don't care about MIME type.  We can always switch
    // between image types.

    return true;
  }
  /**
   *
   * @param outputStream An audio or video output stream
   * @param candidate A candidate stream to be combined with the output
   * @return  True if the candidate could be combined with the
   *   output stream
   */
  areAVStreamsCompatible_<T extends Stream | StreamDB>(outputStream: T, candidate: T): boolean {
    // Check for an exact match.
    if (!PeriodCombiner.areAVStreamsExactMatch_(outputStream, candidate)) {
      // It's not an exact match. See if we can do multi-codec or multi-mimeType
      // stream instead, using SourceBuffer.changeType.
      if (!this.multiTypeVariantsAllowed_) {
        return false;
      }
    }
    // This field is only available on Stream, not StreamDB.
    if ((outputStream as Stream).drmInfos) {
      // Check for compatible DRM systems.  Note that clear streams are
      // implicitly compatible with any DRM and with each other.
      if (!DrmEngine.areDrmCompatible((outputStream as Stream).drmInfos, (candidate as Stream).drmInfos)) {
        return false;
      }
    }

    return true;
  }

  /**
   * @param  allowed If set to true, multi-mimeType or multi-codec
   *   variants will be allowed.
   * @export
   */
  setAllowMultiTypeVariants(allowed: boolean) {
    this.multiTypeVariantsAllowed_ = allowed;
  }

  /**
   * @param  useOnce if true, stream will be used only once in period
   *   flattening algoritnm.
   * @export
   */
  setUseStreamOnce(useOnce: boolean) {
    this.useStreamOnce_ = useOnce;
  }

  private static areAVStreamsExactMatch_<T extends Stream | StreamDB>(a: T, b: T) {
    if (a.mimeType != b.mimeType) {
      return false;
    }
    const getCodec = (codecs: string) => {
      if (!PeriodCombiner.memoizedCodecs.has(codecs)) {
        const normalizedCodec = MimeUtils.getNormalizedCodec(codecs);
        PeriodCombiner.memoizedCodecs.set(codecs, normalizedCodec);
      }
      return PeriodCombiner.memoizedCodecs.get(codecs);
    };
    return getCodec(a.codecs) === getCodec(b.codecs);
  }
  /**
   * Clone a Stream to make an output Stream for combining others across
   * periods.
   * @param stream
   */
  private static cloneStream_(stream: Stream): Stream {
    const clone = Object.assign({}, stream);
    // These are wiped out now and rebuilt later from the various per-period
    // streams that match this output.
    clone.originalId = null;
    clone.createSegmentIndex = () => Promise.resolve();
    clone.closeSegmentIndex = () => {
      if (clone.segmentIndex) {
        clone.segmentIndex.release();
        clone.segmentIndex = null;
      }
      // Close the segment index of the matched streams.
      if (clone.matchedStreams) {
        for (const match of clone.matchedStreams) {
          if ((match as Stream).segmentIndex) {
            (match as Stream).segmentIndex!.release();
            (match as Stream).segmentIndex = null;
          }
        }
      }
    };
    // Clone roles array so this output stream can own it.
    clone.roles = clone.roles.slice();
    clone.segmentIndex = null;
    clone.emsgSchemeIdUris = [];
    clone.keyIds = new Set();
    clone.closedCaptions = null;
    clone.trickModeVideo = null;

    return clone;
  }

  /**
   * Clone a StreamDB to make an output stream for combining others across
   * periods.
   *
   * @param streamDb
   * @return
   * @private
   */
  private static cloneStreamDB_(streamDb: StreamDB): StreamDB {
    const clone = /** @type {shaka.extern.StreamDB} */ Object.assign({}, streamDb);

    // Clone roles array so this output stream can own it.
    clone.roles = clone.roles.slice();
    // These are wiped out now and rebuilt later from the various per-period
    // streams that match this output.
    clone.keyIds = new Set();
    clone.segments = [];
    clone.variantIds = [];
    clone.closedCaptions = null;

    return clone;
  }

  /**
   * Combine the various fields of the input Stream into the output.
   * @param output
   * @param input
   */
  private static concatenateStreams_(output: Stream, input: Stream) {
    // We keep the original stream's bandwidth, resolution, frame rate,
    // sample rate, and channel count to ensure that it's properly
    // matched with similar content in other periods further down
    // the line.

    // Combine arrays, keeping only the unique elements
    const combineArrays = (output: any[] | null, input: any[]) => {
      if (!output) {
        output = [];
      }
      for (const item of input) {
        if (!output.includes(item)) {
          output.push(item);
        }
      }
      return output;
    };
    output.roles = combineArrays(output.roles, input.roles);

    if (input.emsgSchemeIdUris) {
      output.emsgSchemeIdUris = combineArrays(output.emsgSchemeIdUris, input.emsgSchemeIdUris);
    }

    for (const keyId of input.keyIds) {
      output.keyIds.add(keyId);
    }

    if (output.originalId == null) {
      output.originalId = input.originalId;
    } else {
      output.originalId += ',' + (input.originalId || '');
    }

    const commonDrmInfos = DrmEngine.getCommonDrmInfos(output.drmInfos, input.drmInfos);
    if (input.drmInfos.length && output.drmInfos.length && !commonDrmInfos.length) {
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.MANIFEST,
        ShakaError.Code.INCONSISTENT_DRM_ACROSS_PERIODS
      );
    }

    output.drmInfos = commonDrmInfos;

    // The output is encrypted if any input was encrypted.
    output.encrypted = output.encrypted || input.encrypted;

    // Combine the closed captions maps.
    if (input.closedCaptions) {
      if (!output.closedCaptions) {
        output.closedCaptions = new Map();
      }
      for (const [key, value] of input.closedCaptions) {
        output.closedCaptions.set(key, value);
      }
    }

    // Combine trick-play video streams, if present.
    if (input.trickModeVideo) {
      if (!output.trickModeVideo) {
        // Create a fresh output stream for trick-mode playback.
        output.trickModeVideo = PeriodCombiner.cloneStream_(input.trickModeVideo);
        // TODO: fix the createSegmentIndex function for trickModeVideo.
        // The trick-mode tracks in multi-period content should have trick-mode
        // segment indexes whenever available, rather than only regular-mode
        // segment indexes.
        output.trickModeVideo.createSegmentIndex = () => {
          // Satisfy the compiler about the type.
          asserts.assert(output.segmentIndex instanceof MetaSegmentIndex, 'The stream should have a MetaSegmentIndex.');
          output.trickModeVideo!.segmentIndex = (output.segmentIndex as MetaSegmentIndex).clone();
          return Promise.resolve();
        };
      }

      // Concatenate the trick mode input onto the trick mode output.
      PeriodCombiner.concatenateStreams_(output.trickModeVideo, input.trickModeVideo);
    } else if (output.trickModeVideo) {
      // We have a trick mode output, but no input from this Period.  Fill it in
      // from the standard input Stream.
      PeriodCombiner.concatenateStreams_(output.trickModeVideo, input);
    }
  }

  /**
   * Combine the various fields of the input StreamDB into the output.
   *
   * @param  output
   * @param  input
   * @private
   */
  static concatenateStreamDBs_(output: StreamDB, input: StreamDB) {
    // Combine arrays, keeping only the unique elements
    const combineArrays = (output: any[] | null, input: any[]) => {
      if (!output) {
        output = [];
      }
      for (const item of input) {
        if (!output.includes(item)) {
          output.push(item);
        }
      }
      return output;
    };
    output.roles = combineArrays(output.roles, input.roles);

    for (const keyId of input.keyIds) {
      output.keyIds.add(keyId);
    }

    // The output is encrypted if any input was encrypted.
    output.encrypted = output.encrypted && input.encrypted;

    // Concatenate segments without de-duping.
    output.segments.push(...input.segments);

    // Combine the closed captions maps.
    if (input.closedCaptions) {
      if (!output.closedCaptions) {
        output.closedCaptions = new Map();
      }
      for (const [key, value] of input.closedCaptions) {
        output.closedCaptions.set(key, value);
      }
    }
  }

  /**
   * Create a dummy Stream to fill in periods that are missing a certain type,
   * to avoid failing the general flattening algorithm.  This won't be used for
   * audio or video, since those are strictly required in all periods if they
   * exist in any period.
   * @param type
   */
  private static dummyStream_(type: string): Stream {
    return {
      id: 0,
      originalId: '',
      groupId: null,
      createSegmentIndex: () => Promise.resolve(),
      segmentIndex: new SegmentIndex([]),
      mimeType: '',
      codecs: '',
      encrypted: false,
      drmInfos: [],
      keyIds: new Set(),
      language: '',
      originalLanguage: null,
      label: null,
      type,
      primary: false,
      trickModeVideo: null,
      emsgSchemeIdUris: null,
      roles: [],
      forced: false,
      channelsCount: null,
      audioSamplingRate: null,
      spatialAudio: false,
      closedCaptions: null,
      accessibilityPurpose: null,
      external: false,
      fastSwitching: false,
      fullMimeTypes: new Set(),
    };
  }
  private static generateImageKey_(i: Stream | StreamDB) {
    return PeriodCombiner.generateKey_([i.width, i.codecs, i.mimeType]);
  }
  private static generateTextKey_(t: Stream | StreamDB) {
    return PeriodCombiner.generateKey_([t.language, t.label, t.codecs, t.mimeType, (t as Stream).bandwidth, t.roles]);
  }
  private static generateVideoKey_(v: Stream | StreamDB) {
    return PeriodCombiner.generateKey_([
      v.fastSwitching,
      v.width,
      v.frameRate,
      v.codecs,
      v.mimeType,
      v.label,
      v.roles,
      v.closedCaptions ? Array.from(v.closedCaptions.entries()) : null,
      (v as Stream).bandwidth,
    ]);
  }
  private static generateAudioKey_(a: Stream | StreamDB) {
    return PeriodCombiner.generateKey_([
      a.fastSwitching,
      a.channelsCount,
      a.language,
      (a as Stream).bandwidth,
      a.label,
      a.codecs,
      a.mimeType,
      a.roles,
      a.audioSamplingRate,
      a.primary,
    ]);
  }

  private static generateKey_(values: any[]) {
    return JSON.stringify(values);
  }

  static memoizedCodecs = new Map<string, string>();
}

export enum PeriodCombinerBetterOrWorse {
  BETTER = 1,
  EQUAL = 0,
  WORSE = -1,
}
