import { XmlNode } from '../../externs/shaka';
import { AesKey, Stream } from '../../externs/shaka/manifest';
import { asserts } from '../debug/asserts';
import { log } from '../debug/log';
import { TimeRange } from '../media/presentation_timeline';
import { SegmentIndex } from '../media/segment_index';
import { InitSegmentReference, SegmentReference, SegmentReferenceStatus } from '../media/segment_reference';
import { ShakaError } from '../util/error';
import { ManifestParserUtils } from '../util/manifest_parser_utils';
import { ObjectUtils } from '../util/object_utils';
import { StringUtils } from '../util/string_utils';
import { TXml } from '../util/tXml';
import {
  DashParserContext,
  DashParserInheritanceFrame,
  DashParserRequestSegmentCallback,
  DashParserStreamInfo,
} from './dash_parser';
import { MpdUtils } from './mpd_utils';
import { SegmentBase } from './segment_base';

export class SegmentTemplate {
  /**
   * Creates a new StreamInfo object.
   * Updates the existing SegmentIndex, if any.
   * @param context
   * @param requestSegment
   * @param streamMap
   * @param isUpdate True if the manifest is being updated.
   * @param segmentLimit The maximum number of segments to generate for a SegmentTemplate with fixed duration.
   * @param periodDurationMap
   * @param aesKey
   * @param lastSegmentNumber
   * @param isPatchUpdate
   */
  static createStreamInfo(
    context: DashParserContext,
    requestSegment: DashParserRequestSegmentCallback,
    streamMap: Record<string, Stream>,
    isUpdate: boolean,
    segmentLimit: number,
    periodDurationMap: Record<string, number>,
    aesKey: AesKey | null,
    lastSegmentNumber: number | null,
    isPatchUpdate: boolean
  ): DashParserStreamInfo {
    asserts.assert(
      context.representation!.segmentTemplate,
      'Should only be called with SegmentTemplate ' + 'or segment info defined'
    );
    if (!isPatchUpdate && !context.representation!.initialization) {
      context.representation!.initialization = MpdUtils.inheritAttribute(
        context,
        SegmentTemplate.fromInheritance_,
        'initialization'
      );
    }

    const initSegmentReference = context.representation!.initialization
      ? SegmentTemplate.createInitSegment_(context, aesKey)
      : null;

    const info = SegmentTemplate.parseSegmentTemplateInfo_(context);

    SegmentTemplate.checkSegmentTemplateInfo_(context, info);

    // Direct fields of context will be reassigned by the parser before
    // generateSegmentIndex is called.  So we must make a shallow copy first,
    // and use that in the generateSegmentIndex callbacks.
    const shallowCopyOfContext = ObjectUtils.shallowCloneObject(context);

    if (info.indexTemplate) {
      SegmentBase.checkSegmentIndexSupport(context, initSegmentReference);

      return {
        generateSegmentIndex: () => {
          return SegmentTemplate.generateSegmentIndexFromIndexTemplate_(
            shallowCopyOfContext,
            requestSegment,
            initSegmentReference,
            info
          );
        },
      };
    } else if (info.segmentDuration) {
      if (!isUpdate && context.adaptationSet!.contentType !== 'image') {
        context.presentationTimeline.notifyMaxSegmentDuration(info.segmentDuration);
        context.presentationTimeline.notifyMinSegmentStartTime(context.periodInfo!.start);
      }
      return {
        generateSegmentIndex: () => {
          return SegmentTemplate.generateSegmentIndexFromDuration_(
            shallowCopyOfContext,
            info,
            segmentLimit,
            initSegmentReference,
            periodDurationMap,
            aesKey,
            lastSegmentNumber
          );
        },
      };
    } else {
      let segmentIndex: SegmentIndex | null = null;
      let id = null;
      let stream = null;

      if (context.period!.id && context.representation!.id) {
        // Only check/store the index if period and representation IDs are set.
        id = context.period!.id + ',' + context.representation!.id;
        stream = streamMap[id];
        if (stream) {
          segmentIndex = stream.segmentIndex;
        }
      }

      const periodStart = context.periodInfo!.start;
      const periodEnd = context.periodInfo!.duration ? periodStart + context.periodInfo!.duration : Infinity;

      log.debug(`New manifest ${periodStart} - ${periodEnd}`);

      /* When to fit segments.  All refactors should honor/update this table:
       *
       * | dynamic | infinite | last   | should | notes                     |
       * |         | period   | period | fit    |                           |
       * | ------- | -------- | ------ | ------ | ------------------------- |
       * |     F   |     F    |    X   |    T   | typical VOD               |
       * |     F   |     T    |    X   |    X   | impossible: infinite VOD  |
       * |     T   |     F    |    F   |    T   | typical live, old period  |
       * |     T   |     F    |    T   |    F   | typical IPR               |
       * |     T   |     T    |    F   |    X   | impossible: old, infinite |
       * |     T   |     T    |    T   |    F   | typical live, new period  |
       */

      // We never fit the final period of dynamic content, which could be
      // infinite live (with no limit to fit to) or IPR (which would expand the
      // most recent segment to the end of the presentation).
      const shouldFit = !(context.dynamic && context.periodInfo!.isLastPeriod);

      if (!segmentIndex) {
        log.debug(`Creating TSI with end ${periodEnd}`);
        segmentIndex = new TimelineSegmentIndex(
          info,
          context.representation!.id,
          context.bandwidth,
          context.representation!.getBaseUris,
          periodStart,
          periodEnd,
          initSegmentReference,
          shouldFit,
          aesKey,
          context.representation!.segmentSequenceCadence
        );
      } else {
        const tsi = segmentIndex as TimelineSegmentIndex;
        tsi.appendTemplateInfo(info, periodStart, periodEnd, shouldFit, initSegmentReference);
        const availabilityStart = context.presentationTimeline.getSegmentAvailabilityStart();
        tsi.evict(availabilityStart);
      }

      if (info.timeline && context.adaptationSet!.contentType !== 'image') {
        const timeline = info.timeline;
        context.presentationTimeline.notifyTimeRange(timeline, periodStart);
      }
      if (stream && context.dynamic) {
        stream.segmentIndex = segmentIndex;
      }

      return {
        generateSegmentIndex: () => {
          // If segmentIndex is deleted, or segmentIndex's references are
          // released by closeSegmentIndex(), we should set the value of
          // segmentIndex again.
          if (segmentIndex instanceof TimelineSegmentIndex && segmentIndex.isEmpty()) {
            segmentIndex.appendTemplateInfo(info, periodStart, periodEnd, shouldFit, initSegmentReference);
          }
          return Promise.resolve(segmentIndex);
        },
      };
    }
  }

  /**
   * Ingests Patch MPD segments into timeline.
   *
   * @param context
   * @param patchNode
   */
  static modifyTimepoints(context: DashParserContext, patchNode: XmlNode) {
    const timelineNode = MpdUtils.inheritChild(context, SegmentTemplate.fromInheritance_, 'SegmentTimeline')!;
    asserts.assert(timelineNode, 'timeline node not found');
    const timepoints = TXml.findChildren(timelineNode, 'S');

    asserts.assert(timepoints, 'timepoints should exist');
    TXml.modifyNodes(timepoints, patchNode);
    timelineNode.children = timepoints;
  }

  /**
   *  Removes all segments from timeline.
   * @param context
   */
  static removeTimepoints(context: DashParserContext) {
    const timelineNode = MpdUtils.inheritChild(context, SegmentTemplate.fromInheritance_, 'SegmentTimeline')!;
    asserts.assert(timelineNode, 'timeline node not found');
    timelineNode.children = [];
  }

  /**
   * Generates a SegmentIndex from fixed-duration segments.
   * @param context
   * @param info
   * @param segmentLimit
   * @param initSegmentReference
   * @param periodDurationMap
   * @param aesKey
   * @param lastSegmentNumber
   */
  static generateSegmentIndexFromDuration_(
    context: DashParserContext,
    info: SegmentTemplateInfo,
    segmentLimit: number,
    initSegmentReference: InitSegmentReference | null,
    periodDurationMap: Record<string, number>,
    aesKey: AesKey | null,
    lastSegmentNumber: number | null
  ) {
    asserts.assert(info.mediaTemplate, 'There should be a media template with duration');
    const presentationTimeline = context.presentationTimeline;

    // Capture values that could change as the parsing context moves on to
    // other parts of the manifest.
    const periodStart = context.periodInfo!.start;
    const periodId = context.period!.id;
    const initialPeriodDuration = context.periodInfo!.duration;

    // For multi-period live streams the period duration may not be known until
    // the following period appears in an updated manifest. periodDurationMap
    // provides the updated period duration.
    const getPeriodEnd = () => {
      const periodDuration = (periodId != null && periodDurationMap[periodId]) || initialPeriodDuration;
      const periodEnd = periodDuration ? periodStart + periodDuration : Infinity;
      return periodEnd;
    };

    const segmentDuration = info.segmentDuration!;
    asserts.assert(segmentDuration != null, 'Segment duration must not be null!');
    const startNumber = info.startNumber;
    const timescale = info.timescale;

    const template = info.mediaTemplate;
    const bandwidth = context.bandwidth || null;
    const id = context.representation!.id;
    const getBaseUris = context.representation!.getBaseUris;

    const timestampOffset = periodStart - info.scaledPresentationTimeOffset;

    // Computes the range of presentation timestamps both within the period and
    // available.  This is an intersection of the period range and the
    // availability window.
    const computeAvailablePeriodRange = () => {
      return [
        Math.max(presentationTimeline.getSegmentAvailabilityStart(), periodStart),

        Math.min(presentationTimeline.getSegmentAvailabilityEnd(), getPeriodEnd()),
      ];
    };
    // Computes the range of absolute positions both within the period and
    // available.  The range is inclusive.  These are the positions for which we
    // will generate segment references.
    const computeAvailablePositionRange = () => {
      // In presentation timestamps.
      const availablePresentationTimes = computeAvailablePeriodRange();
      asserts.assert(availablePresentationTimes.every(isFinite), 'Available presentation times must be finite!');
      asserts.assert(
        availablePresentationTimes.every((x) => x >= 0),
        'Available presentation times must be positive!'
      );
      asserts.assert(segmentDuration != null, 'Segment duration must not be null!');

      // In period-relative timestamps.
      const availablePeriodTimes = availablePresentationTimes.map((x) => x - periodStart);
      // These may sometimes be reversed ([1] <= [0]) if the period is
      // completely unavailable.  The logic will still work if this happens,
      // because we will simply generate no references.

      // In period-relative positions (0-based).
      const availablePeriodPositions = [
        Math.ceil(availablePeriodTimes[0] / segmentDuration!),
        Math.ceil(availablePeriodTimes[1] / segmentDuration!) - 1,
      ];

      // For Low Latency we can request the partial current position.
      if (context.representation!.availabilityTimeOffset) {
        availablePeriodPositions[1]++;
      }

      // In absolute positions.
      const availablePresentationPositions = availablePeriodPositions.map((x) => x + startNumber);
      return availablePresentationPositions;
    };

    // For Live, we must limit the initial SegmentIndex in size, to avoid
    // consuming too much CPU or memory for content with gigantic
    // timeShiftBufferDepth (which can have values up to and including
    // Infinity).
    const range = computeAvailablePositionRange();
    const minPosition = context.dynamic ? Math.max(range[0], range[1] - segmentLimit + 1) : range[0];
    const maxPosition = lastSegmentNumber || range[1];

    const references = [];

    const createReference = (position: number) => {
      // These inner variables are all scoped to the inner loop, and can be used
      // safely in the callback below.

      asserts.assert(segmentDuration != null, 'Segment duration must not be null!');

      // Relative to the period start.
      const positionWithinPeriod = position - startNumber;
      const segmentPeriodTime = positionWithinPeriod * segmentDuration!;

      // What will appear in the actual segment files.  The media timestamp is
      // what is expected in the $Time$ template.
      const segmentMediaTime = segmentPeriodTime + info.scaledPresentationTimeOffset;

      const getUris = () => {
        let time: number | bigint = segmentMediaTime * timescale;
        if ('BigInt' in window && time > Number.MAX_SAFE_INTEGER) {
          time = BigInt(segmentMediaTime) * BigInt(timescale);
        }
        const mediaUri = MpdUtils.fillUriTemplate(template!, id, position, /* subNumber= */ null, bandwidth, time);
        return ManifestParserUtils.resolveUris(getBaseUris(), [mediaUri]);
      };

      // Relative to the presentation.
      const segmentStart = segmentPeriodTime + periodStart;
      const trueSegmentEnd = segmentStart + segmentDuration!;
      // Cap the segment end at the period end so that references from the
      // next period will fit neatly after it.
      const segmentEnd = Math.min(trueSegmentEnd, getPeriodEnd());

      // This condition will be true unless the segmentStart was >= periodEnd.
      // If we've done the position calculations correctly, this won't happen.
      asserts.assert(segmentStart < segmentEnd, 'Generated a segment outside of the period!');

      const ref = new SegmentReference(
        segmentStart,
        segmentEnd,
        getUris,
        /* startByte= */ 0,
        /* endByte= */ null,
        initSegmentReference,
        timestampOffset,
        /* appendWindowStart= */ periodStart,
        /* appendWindowEnd= */ getPeriodEnd(),
        /* partialReferences= */ [],
        /* tilesLayout= */ '',
        /* tileDuration= */ null,
        /* syncTime= */ null,
        SegmentReferenceStatus.AVAILABLE,
        aesKey
      );
      ref.codecs = context.representation!.codecs;
      ref.mimeType = context.representation!.mimeType;
      // This is necessary information for thumbnail streams:
      ref.trueEndTime = trueSegmentEnd;
      return ref;
    };

    for (let position = minPosition; position <= maxPosition; ++position) {
      const reference = createReference(position);
      references.push(reference);
    }

    const segmentIndex = new SegmentIndex(references);

    // If the availability timeline currently ends before the period, we will
    // need to add references over time.
    const willNeedToAddReferences = presentationTimeline.getSegmentAvailabilityEnd() < getPeriodEnd();

    // When we start a live stream with a period that ends within the
    // availability window we will not need to add more references, but we will
    // need to evict old references.
    const willNeedToEvictReferences = presentationTimeline.isLive();

    if (willNeedToAddReferences || willNeedToEvictReferences) {
      // The period continues to get longer over time, so check for new
      // references once every |segmentDuration| seconds.
      // We clamp to |minPosition| in case the initial range was reversed and no
      // references were generated.  Otherwise, the update would start creating
      // negative positions for segments in periods which begin in the future.
      let nextPosition = Math.max(minPosition, maxPosition + 1);
      let updateTime: number = segmentDuration;
      // For low latency we need to evict very frequently.
      if (context.representation!.availabilityTimeOffset) {
        updateTime = 0.1;
      }
      segmentIndex.updateEvery(updateTime, () => {
        // Evict any references outside the window.
        const availabilityStartTime = presentationTimeline.getSegmentAvailabilityStart();
        segmentIndex.evict(availabilityStartTime);

        // Compute any new references that need to be added.
        const [_, maxPosition] = computeAvailablePositionRange();
        const references = [];
        while (nextPosition <= maxPosition) {
          const reference = createReference(nextPosition);
          references.push(reference);
          nextPosition++;
        }

        // The timer must continue firing until the entire period is
        // unavailable, so that all references will be evicted.
        if (availabilityStartTime > getPeriodEnd() && !references.length) {
          // Signal stop.
          return null;
        }
        return references;
      });
    }

    return Promise.resolve(segmentIndex);
  }

  static generateSegmentIndexFromIndexTemplate_(
    context: DashParserContext,
    requestSegment: DashParserRequestSegmentCallback,
    init: InitSegmentReference | null,
    info: SegmentTemplateInfo
  ): Promise<SegmentIndex> {
    asserts.assert(info.indexTemplate, 'must be using index template');
    const filledTemplate = MpdUtils.fillUriTemplate(
      info.indexTemplate!,
      context.representation!.id,
      null,
      null,
      context.bandwidth || null,
      null
    );

    const resolvedUris = ManifestParserUtils.resolveUris(context.representation!.getBaseUris(), [filledTemplate]);
    return SegmentBase.generateSegmentIndexFromUris(
      context,
      requestSegment,
      init,
      resolvedUris,
      0,
      null,
      info.scaledPresentationTimeOffset
    );
  }
  /**
   * Verifies a SegmentTemplate info object.
   * @param context
   * @param info
   */
  private static checkSegmentTemplateInfo_(context: DashParserContext, info: SegmentTemplateInfo) {
    let n = 0;
    n += info.indexTemplate ? 1 : 0;
    n += info.timeline ? 1 : 0;
    n += info.segmentDuration ? 1 : 0;
    if (n == 0) {
      log.error(
        'SegmentTemplate does not contain any segment information:',
        'the SegmentTemplate must contain either an index URL template',
        'a SegmentTimeline, or a segment duration.',
        context.representation
      );
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.MANIFEST,
        ShakaError.Code.DASH_NO_SEGMENT_INFO
      );
    } else if (n != 1) {
      log.warning(
        'SegmentTemplate containes multiple segment information sources:',
        'the SegmentTemplate should only contain an index URL template,',
        'a SegmentTimeline or a segment duration.',
        context.representation
      );
      if (info.indexTemplate) {
        log.info('Using the index URL template by default.');
        info.timeline = null as any;
        info.segmentDuration = null;
      } else {
        asserts.assert(info.timeline, 'There should be a timeline');
        log.info('Using the SegmentTimeline by default.');
        info.segmentDuration = null;
      }
    }

    if (!info.indexTemplate && !info.mediaTemplate) {
      log.error(
        'SegmentTemplate does not contain sufficient segment information:',
        "the SegmentTemplate's media URL template is missing.",
        context.representation
      );
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.MANIFEST,
        ShakaError.Code.DASH_NO_SEGMENT_INFO
      );
    }
  }

  /**
   * Parses a SegmentTemplate element into an info object.
   * @param context
   */
  static parseSegmentTemplateInfo_(context: DashParserContext): SegmentTemplateInfo {
    const segmentInfo = MpdUtils.parseSegmentInfo(context, SegmentTemplate.fromInheritance_);

    const media = MpdUtils.inheritAttribute(context, SegmentTemplate.fromInheritance_, 'media');

    const index = MpdUtils.inheritAttribute(context, SegmentTemplate.fromInheritance_, 'index');

    return {
      segmentDuration: segmentInfo.segmentDuration,
      timescale: segmentInfo.timescale,
      startNumber: segmentInfo.startNumber,
      scaledPresentationTimeOffset: segmentInfo.scaledPresentationTimeOffset,
      unscaledPresentationTimeOffset: segmentInfo.unscaledPresentationTimeOffset,
      timeline: segmentInfo.timeline!,
      mediaTemplate: media && StringUtils.htmlUnescape(media),
      indexTemplate: index,
      mimeType: context.representation!.mimeType,
      codecs: context.representation!.codecs,
    };
  }

  /**
   * Creates an init segment reference from a context object
   * @param context
   * @param aesKey
   */
  private static createInitSegment_(context: DashParserContext, aesKey: AesKey | null): InitSegmentReference | null {
    let initialization = context.representation!.initialization;
    if (!initialization) {
      initialization = MpdUtils.inheritAttribute(context, SegmentTemplate.fromInheritance_, 'initialization');
    }
    if (!initialization) {
      return null;
    }
    initialization = StringUtils.htmlUnescape(initialization);

    const repId = context.representation!.id;
    const bandwidth = context.bandwidth || null;
    const getBaseUris = context.representation!.getBaseUris;

    const getUris = () => {
      asserts.assert(initialization, 'Should have returned earler');
      const filledTemplate = MpdUtils.fillUriTemplate(initialization, repId, null, null, bandwidth, null);
      const resolvedUris = ManifestParserUtils.resolveUris(getBaseUris(), [filledTemplate]);
      return resolvedUris;
    };

    const qualityInfo = SegmentBase.createQualityInfo(context);
    const ref = new InitSegmentReference(
      getUris,
      /* startByte= */ 0,
      /* endByte= */ null,
      qualityInfo,
      /* timescale= */ null,
      /* segmentData= */ null,
      aesKey
    );
    ref.codecs = context.representation!.codecs;
    ref.mimeType = context.representation!.mimeType;
    return ref;
  }

  /**
   * @param frame
   * @return
   * @private
   */
  private static fromInheritance_(frame: DashParserInheritanceFrame | null): XmlNode {
    return frame!.segmentTemplate!;
  }
}

export class TimelineSegmentIndex extends SegmentIndex {
  private templateInfo_: SegmentTemplateInfo | null;
  private representationId_: string | null;
  private bandwidth_: number;
  private getBaseUris_: () => string[];
  private periodStart_: number;
  private periodEnd_: number;
  private initSegmentReference_: InitSegmentReference | null;
  private aesKey_: AesKey | null;
  private segmentSequenceCadence_: number;

  constructor(
    templateInfo: SegmentTemplateInfo,
    representationId: string | null,
    bandwidth: number,
    getBaseUris: () => string[],
    periodStart: number,
    periodEnd: number,
    initSegmentReference: InitSegmentReference | null,
    shouldFit: boolean,
    aesKey: AesKey | null,
    segmentSequenceCadence: number
  ) {
    super([]);
    this.templateInfo_ = templateInfo;

    this.representationId_ = representationId;

    this.bandwidth_ = bandwidth;

    this.getBaseUris_ = getBaseUris;

    this.periodStart_ = periodStart;

    this.periodEnd_ = periodEnd;

    this.initSegmentReference_ = initSegmentReference;

    this.aesKey_ = aesKey;

    this.segmentSequenceCadence_ = segmentSequenceCadence;
    if (shouldFit) {
      this.fitTimeline();
    }
  }

  /**
   * @override
   */
  release() {
    super.release();
    this.templateInfo_ = null;
    // We cannot release other fields, as segment index can
    // be recreated using only template info.
  }

  evict(time: number): void {
    if (!this.templateInfo_) {
      return;
    }
    log.debug(`${this.representationId_} Evicting at ${time}`);
    let numToEvict = 0;
    const timeline = this.templateInfo_.timeline!;
    for (let i = 0; i < timeline.length; i += 1) {
      const range = timeline[i];
      const end = range.end + this.periodStart_;
      const start = range.start + this.periodStart_;

      if (end <= time) {
        log.debug(`Evicting ${start} - ${end}`);
        numToEvict += 1;
      } else {
        break;
      }
    }
    if (numToEvict > 0) {
      this.templateInfo_.timeline = timeline.slice(numToEvict);
      if (this.references.length >= numToEvict) {
        this.references = this.references.slice(numToEvict);
      }

      this.numEvicted_ += numToEvict;

      if (this.getNumReferences() === 0) {
        this.release();
      }
    }
  }

  getNumReferences() {
    if (this.templateInfo_) {
      return this.templateInfo_.timeline!.length;
    } else {
      return 0;
    }
  }

  /**
   * Merge new template info
   * @param info
   * @param periodStart
   * @param periodEnd
   * @param shouldFit
   * @param initSegmentReference
   * @returns
   */
  appendTemplateInfo(
    info: SegmentTemplateInfo,
    periodStart: number,
    periodEnd: number,
    shouldFit: boolean,
    initSegmentReference: InitSegmentReference | null
  ) {
    this.updateInitSegmentReference(initSegmentReference);
    if (!this.templateInfo_) {
      this.templateInfo_ = info;
      this.periodStart_ = periodStart;
      this.periodEnd_ = periodEnd;
    } else {
      if (!this.templateInfo_.timeline) {
        return;
      }
      const currentTimeline = this.templateInfo_.timeline;

      this.templateInfo_.mediaTemplate = info.mediaTemplate;

      // Append timeline
      let newEntries;
      if (currentTimeline.length) {
        const lastCurrentEntry = currentTimeline[currentTimeline.length - 1];
        newEntries = info.timeline.filter((entry) => {
          return entry.start >= lastCurrentEntry.end;
        });
      } else {
        newEntries = info.timeline.slice();
      }

      if (newEntries.length > 0) {
        log.debug(`Appending ${newEntries.length} entries`);
        this.templateInfo_.timeline.push(...newEntries);
      }
      if (this.periodEnd_ !== periodEnd) {
        this.periodEnd_ = periodEnd;
      }
    }
    if (shouldFit) {
      this.fitTimeline();
    }
  }

  /**
   * Updates the init segment reference and propagates the update to all
   * references.
   * @param {shaka.media.InitSegmentReference} initSegmentReference
   */
  updateInitSegmentReference(initSegmentReference: InitSegmentReference | null) {
    if (this.initSegmentReference_ === initSegmentReference) {
      return;
    }

    this.initSegmentReference_ = initSegmentReference;
    for (const reference of this.references) {
      if (reference) {
        reference.updateInitSegmentReference(initSegmentReference);
      }
    }
  }

  /**
   *
   * @param {number} time
   */
  isBeforeFirstEntry(time: number) {
    const hasTimeline = this.templateInfo_ && this.templateInfo_.timeline && this.templateInfo_.timeline.length;

    if (hasTimeline) {
      const timeline = this.templateInfo_!.timeline;
      return time < timeline[0].start + this.periodStart_;
    } else {
      return false;
    }
  }

  /**
   * Fit timeline entries to period boundaries
   */
  fitTimeline() {
    if (this.getIsImmutable()) {
      return;
    }
    if (!this.templateInfo_) {
      return;
    }
    const timeline = this.templateInfo_.timeline;
    while (timeline.length) {
      const lastTimePeriod = timeline[timeline.length - 1];
      if (lastTimePeriod.start >= this.periodEnd_) {
        timeline.pop();
      } else {
        break;
      }
    }

    this.evict(this.periodStart_);

    // Do NOT adjust last range to match period end! With high precision
    // timestamps several recalculations may give wrong results on less precise
    // platforms. To mitigate that, we're using cached |periodEnd_| value in
    // find/get() methods whenever possible.
  }

  find(time: number) {
    log.debug(`Find ${time}`);

    if (this.isBeforeFirstEntry(time)) {
      return this.numEvicted_;
    }

    if (!this.templateInfo_) {
      return null;
    }

    const timeline = this.templateInfo_.timeline;

    // Early exit if the time isn't within this period
    if (time < this.periodStart_ || time >= this.periodEnd_) {
      return null;
    }

    const lastIndex = timeline.length - 1;

    for (let i = 0; i < timeline.length; i++) {
      const range = timeline[i];
      const start = range.start + this.periodStart_;
      // A rounding error can cause /time/ to equal e.endTime or fall in between
      // the references by a fraction of a second. To account for this, we use
      // the start of the next segment as /end/, unless this is the last
      // reference, in which case we use the period end as the /end/
      let end;

      if (i < lastIndex) {
        end = timeline[i + 1].start + this.periodStart_;
      } else if (this.periodEnd_ === Infinity) {
        end = range.end + this.periodStart_;
      } else {
        end = this.periodEnd_;
      }

      if (time >= start && time < end) {
        return i + this.numEvicted_;
      }
    }

    return null;
  }

  /**
   * @override
   */
  get(position: number) {
    const correctedPosition = position - this.numEvicted_;
    if (correctedPosition < 0 || correctedPosition >= this.getNumReferences() || !this.templateInfo_) {
      return null;
    }

    let ref = this.references[correctedPosition];

    if (!ref) {
      const mediaTemplate = this.templateInfo_.mediaTemplate;
      const range = this.templateInfo_.timeline[correctedPosition];
      const segmentReplacement = range.segmentPosition;
      const timeReplacement = this.templateInfo_.unscaledPresentationTimeOffset + range.unscaledStart;
      const timestampOffset = this.periodStart_ - this.templateInfo_.scaledPresentationTimeOffset;
      const trueSegmentEnd = this.periodStart_ + range.end;
      let segmentEnd = trueSegmentEnd;
      if (correctedPosition === this.getNumReferences() - 1 && this.periodEnd_ !== Infinity) {
        segmentEnd = this.periodEnd_;
      }
      const codecs = this.templateInfo_.codecs;
      const mimeType = this.templateInfo_.mimeType;

      const partialSegmentRefs = [];

      const partialDuration = (range.end - range.start) / range.partialSegments;

      for (let i = 0; i < range.partialSegments; i++) {
        const start = range.start + partialDuration * i;
        const end = start + partialDuration;
        const subNumber = i + 1;
        let uris: string[] | null = null;
        const getPartialUris = () => {
          if (!this.templateInfo_) {
            return [];
          }
          if (uris == null) {
            uris = TimelineSegmentIndex.createUris_(
              this.templateInfo_.mediaTemplate!,
              this.representationId_!,
              segmentReplacement,
              this.bandwidth_!,
              timeReplacement,
              subNumber,
              this.getBaseUris_
            );
          }
          return uris;
        };
        const partial = new SegmentReference(
          this.periodStart_ + start,
          this.periodStart_ + end,
          getPartialUris,
          /* startByte= */ 0,
          /* endByte= */ null,
          this.initSegmentReference_,
          timestampOffset,
          this.periodStart_,
          this.periodEnd_,
          /* partialReferences= */ [],
          /* tilesLayout= */ '',
          /* tileDuration= */ null,
          /* syncTime= */ null,
          SegmentReferenceStatus.AVAILABLE,
          this.aesKey_
        );
        partial.codecs = codecs;
        partial.mimeType = mimeType;
        if (this.segmentSequenceCadence_ == 0) {
          if (i > 0) {
            partial.markAsNonIndependent();
          }
        } else if (i % this.segmentSequenceCadence_ != 0) {
          partial.markAsNonIndependent();
        }
        partialSegmentRefs.push(partial);
      }

      const createUrisCb = () => {
        if (range.partialSegments > 0) {
          return [];
        }
        return TimelineSegmentIndex.createUris_(
          mediaTemplate!,
          this.representationId_!,
          segmentReplacement,
          this.bandwidth_,
          timeReplacement,
          /* subNumber= */ null,
          this.getBaseUris_
        );
      };

      ref = new SegmentReference(
        this.periodStart_ + range.start,
        segmentEnd,
        createUrisCb,
        /* startByte= */ 0,
        /* endByte= */ null,
        this.initSegmentReference_,
        timestampOffset,
        this.periodStart_,
        this.periodEnd_,
        partialSegmentRefs,
        /* tilesLayout= */ '',
        /* tileDuration= */ null,
        /* syncTime= */ null,
        SegmentReferenceStatus.AVAILABLE,
        this.aesKey_,
        /* allPartialSegments= */ range.partialSegments > 0
      );
      ref.codecs = codecs;
      ref.mimeType = mimeType;
      ref.trueEndTime = trueSegmentEnd;
      this.references[correctedPosition] = ref;
    }

    return ref;
  }

  /**

  /**
   * Fill in a specific template with values to get the segment uris
   *
   * @private
   */
  static createUris_(
    mediaTemplate: string,
    repId: string,
    segmentReplacement: string | number,
    bandwidth: string | number,
    timeReplacement: number,
    subNumber: string | number | null,
    getBaseUris: () => string[]
  ) {
    const mediaUri = MpdUtils.fillUriTemplate(
      mediaTemplate,
      repId,
      segmentReplacement,
      subNumber,
      bandwidth || null,
      timeReplacement
    );
    return ManifestParserUtils.resolveUris(getBaseUris(), [mediaUri]).map((g) => {
      return g.toString();
    });
  }
}

/**
 *  Contains information about a SegmentTemplate.
 */
export interface SegmentTemplateInfo {
  // The time-scale of the representation.
  timescale: number;
  // The duration of the segments in seconds, if given.
  segmentDuration: number | null;
  // The start number of the segments; 1 or greater.
  startNumber: number;
  // The presentation time offset of the representation, in seconds.
  scaledPresentationTimeOffset: number;
  // The presentation time offset of the representation, in timescale units.
  unscaledPresentationTimeOffset: number;
  // The timeline of the representation, if given.  Times in seconds.
  timeline: TimeRange[];
  // The media URI template, if given.
  mediaTemplate: string | null;
  // The index URI template, if given.
  indexTemplate: string | null;

  mimeType: string;
  codecs: string;
}
