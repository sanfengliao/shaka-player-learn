import { XmlNode } from '../../externs/shaka';
import { AesKey, Stream } from '../../externs/shaka/manifest';
import { asserts } from '../debug/asserts';
import { log } from '../debug/log';
import { TimeRange } from '../media/presentation_timeline';
import { SegmentIndex } from '../media/segment_index';
import { InitSegmentReference, SegmentReference, SegmentReferenceStatus } from '../media/segment_reference';
import { ShakaError } from '../util/error';
import { Functional } from '../util/functional';
import { ManifestParserUtils } from '../util/manifest_parser_utils';
import { StringUtils } from '../util/string_utils';
import { TXml } from '../util/tXml';
import { DashParserContext, DashParserInheritanceFrame } from './dash_parser';
import { MpdUtils } from './mpd_utils';
import { SegmentBase } from './segment_base';

/**
 * @summary A set of functions for parsing SegmentList elements.
 */
export class SegmentList {
  /**
   * Creates a new StreamInfo object.
   * Updates the existing SegmentIndex, if any.
   *
   * @param context
   * @param streamMap
   * @param aesKey
   * @return
   */
  static createStreamInfo(context: DashParserContext, streamMap: Record<string, Stream>, aesKey?: AesKey) {
    asserts.assert(context.representation!.segmentList, 'Should only be called with SegmentList');
    const initSegmentReference = SegmentBase.createInitSegment(context, SegmentList.fromInheritance_, aesKey);
    const info = SegmentList.parseSegmentListInfo_(context);

    SegmentList.checkSegmentListInfo_(context, info);
    let segmentIndex = null;
    let stream = null;
    if (context.period!.id && context.representation!.id) {
      // Only check/store the index if period and representation IDs are set.
      const id = context.period!.id + ',' + context.representation!.id;
      stream = streamMap[id];
      if (stream) {
        segmentIndex = stream.segmentIndex;
      }
    }

    const references = SegmentList.createSegmentReferences_(
      context.periodInfo!.start,
      context.periodInfo!.duration!,
      info.startNumber,
      context.representation!.getBaseUris,
      info,
      initSegmentReference,
      aesKey,
      context.representation!.mimeType,
      context.representation!.codecs
    );

    const isNew = !segmentIndex;
    if (segmentIndex) {
      const start = context.presentationTimeline.getSegmentAvailabilityStart();
      segmentIndex.mergeAndEvict(references, start);
    } else {
      segmentIndex = new SegmentIndex(references);
    }
    context.presentationTimeline.notifySegments(references);

    if (!context.dynamic || !context.periodInfo!.isLastPeriod) {
      const periodStart = context.periodInfo!.start;
      const periodEnd = context.periodInfo!.duration
        ? context.periodInfo!.start + context.periodInfo!.duration
        : Infinity;
      segmentIndex.fit(periodStart, periodEnd, isNew);
    }

    if (stream) {
      stream.segmentIndex = segmentIndex;
    }

    return {
      generateSegmentIndex: () => {
        if (!segmentIndex || segmentIndex.isEmpty()) {
          segmentIndex.merge(references);
        }
        return Promise.resolve(segmentIndex);
      },
    };
  }

  /**
   * @param frame
   * @return
   * @private
   */
  static fromInheritance_(frame?: DashParserInheritanceFrame): XmlNode {
    return frame!.segmentList!;
  }

  /**
   * Parses the SegmentList items to create an info object.
   * @param context
   */
  private static parseSegmentListInfo_(context: DashParserContext): SegmentListInfo {
    const mediaSegments = SegmentList.parseMediaSegments_(context);
    const segmentInfo = MpdUtils.parseSegmentInfo(context, SegmentList.fromInheritance_);

    let startNumber = segmentInfo.startNumber;
    if (startNumber == 0) {
      log.warning('SegmentList@startNumber must be > 0');
      startNumber = 1;
    }

    let startTime = 0;
    if (segmentInfo.segmentDuration) {
      // See DASH sec. 5.3.9.5.3
      // Don't use presentationTimeOffset for @duration.
      startTime = segmentInfo.segmentDuration * (startNumber - 1);
    } else if (segmentInfo.timeline && segmentInfo.timeline.length > 0) {
      // The presentationTimeOffset was considered in timeline creation.
      startTime = segmentInfo.timeline[0].start;
    }

    return {
      segmentDuration: segmentInfo.segmentDuration,
      startTime: startTime,
      startNumber: startNumber,
      scaledPresentationTimeOffset: segmentInfo.scaledPresentationTimeOffset,
      timeline: segmentInfo.timeline,
      mediaSegments: mediaSegments,
    };
  }

  static checkSegmentListInfo_(context: DashParserContext, info: SegmentListInfo) {
    if (!info.segmentDuration && !info.timeline && info.mediaSegments.length > 1) {
      log.warning(
        'SegmentList does not contain sufficient segment information:',
        'the SegmentList specifies multiple segments,',
        'but does not specify a segment duration or timeline.',
        context.representation
      );
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.MANIFEST,
        ShakaError.Code.DASH_NO_SEGMENT_INFO
      );
    }

    if (!info.segmentDuration && !context.periodInfo!.duration && !info.timeline && info.mediaSegments.length == 1) {
      log.warning(
        'SegmentList does not contain sufficient segment information:',
        'the SegmentList specifies one segment,',
        'but does not specify a segment duration, period duration,',
        'or timeline.',
        context.representation
      );
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.MANIFEST,
        ShakaError.Code.DASH_NO_SEGMENT_INFO
      );
    }

    if (info.timeline && info.timeline.length == 0) {
      log.warning(
        'SegmentList does not contain sufficient segment information:',
        'the SegmentList has an empty timeline.',
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
   * Creates an array of segment references for the given data.
   * @param periodStart
   * @param periodDuration
   * @param startNumber
   * @param getBaseUris
   * @param info
   * @param initSegmentReference
   * @param aesKey
   * @param mimeType
   * @param codecs
   */
  static createSegmentReferences_(
    periodStart: number,
    periodDuration: number,
    startNumber: number,
    getBaseUris: () => string[],
    info: SegmentListInfo,
    initSegmentReference: InitSegmentReference | null,
    aesKey: AesKey | undefined,
    mimeType: string,
    codecs: string
  ): SegmentReference[] {
    let max = info.mediaSegments.length;

    if (info.timeline && info.timeline.length !== info.mediaSegments.length) {
      max = Math.min(info.timeline.length, info.mediaSegments.length);
      log.warning(
        'The number of items in the segment timeline and the number of ',
        'segment URLs do not match, truncating',
        info.mediaSegments.length,
        'to',
        max
      );
    }

    const timestampOffset = periodStart - info.scaledPresentationTimeOffset;
    const appendWindowStart = periodStart;
    const appendWindowEnd = periodDuration ? periodStart + periodDuration : Infinity;

    const references: SegmentReference[] = [];
    let prevEndTime = info.startTime;
    for (let i = 0; i < max; i++) {
      const segment = info.mediaSegments[i];
      const startTime = prevEndTime;
      let endTime;
      if (info.segmentDuration != null) {
        endTime = startTime + info.segmentDuration;
      } else if (info.timeline) {
        // Ignore the timepoint start since they are continuous.
        endTime = info.timeline[i].end;
      } else {
        // If segmentDuration and timeline are null then there must
        // be exactly one segment.
        asserts.assert(
          info.mediaSegments.length == 1 && periodDuration,
          'There should be exactly one segment with a Period duration.'
        );
        endTime = startTime + periodDuration;
      }

      let uris: string[];
      const getUris = () => {
        if (uris) {
          uris = ManifestParserUtils.resolveUris(getBaseUris(), [segment.mediaUri]);
        }
        return uris;
      };

      const ref = new SegmentReference(
        periodStart + startTime,
        periodStart + endTime,
        getUris,
        segment.start,
        segment.end,
        initSegmentReference,
        timestampOffset,
        appendWindowStart,
        appendWindowEnd,
        /* partialReferences= */ [],
        /* tilesLayout= */ '',
        /* tileDuration= */ null,
        /* syncTime= */ null,
        SegmentReferenceStatus.AVAILABLE,
        aesKey
      );
      ref.codecs = codecs;
      ref.mimeType = mimeType;
      references.push(ref);
      prevEndTime = endTime;
    }
    return references;
  }
  /**
   * Parses the media URIs from the context.
   * @param context
   * @returns
   */
  static parseMediaSegments_(context: DashParserContext): SegmentListMediaSegment[] {
    const segmentLists = [
      context.representation?.segmentList,
      context.adaptationSet?.segmentList,
      context.period?.segmentList,
    ].filter(Functional.isNotNull) as XmlNode[];

    // Search each SegmentList for one with at least one SegmentURL element,
    // select the first one, and convert each SegmentURL element to a tuple.
    return segmentLists
      .map((node) => {
        return TXml.findChildren(node, 'SegmentURL');
      })
      .reduce((all, part) => {
        return all.length > 0 ? all : part;
      }, [])
      .map((urlNode) => {
        if (urlNode.attributes['indexRange'] && !context.indexRangeWarningGiven) {
          context.indexRangeWarningGiven = true;
          log.warning(
            'We do not support the SegmentURL@indexRange attribute on ' +
              'SegmentList.  We only use the SegmentList@duration ' +
              'attribute or SegmentTimeline, which must be accurate.'
          );
        }

        const uri = StringUtils.htmlUnescape(urlNode.attributes['media']);
        const range = TXml.parseAttr(urlNode, 'mediaRange', TXml.parseRange, { start: 0, end: undefined as any });
        return { mediaUri: uri, start: range!.start, end: range!.end };
      });
  }
}

export interface SegmentListMediaSegment {
  // The URI of the segment.
  mediaUri: string;
  // The start byte of the segment.
  start: number;
  // The end byte of the segment, or null.
  end: number | null;
}

/**
 *  Contains information about a SegmentList.
 */
export interface SegmentListInfo {
  // The duration of the segments, if given.
  segmentDuration: number | null;
  // The start time of the first segment, in seconds.
  startTime: number;
  // The start number of the segments; 1 or greater.
  startNumber: number;
  // The scaledPresentationTimeOffset of the representation, in seconds.
  scaledPresentationTimeOffset: number;

  // The timeline of the representation, if given.  Times in seconds.
  timeline: TimeRange[] | null;
  // The URI and byte-ranges of the media segments.
  mediaSegments: SegmentListMediaSegment[];
}
