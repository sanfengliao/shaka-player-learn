import { MediaQualityInfo, XmlNode } from '../../externs/shaka';
import { AesKey } from '../../externs/shaka/manifest';
import { asserts } from '../debug/asserts';
import { log } from '../debug/log';
import { Mp4SegmentIndexParser } from '../media/mp4_segment_index_parser';
import { SegmentIndex } from '../media/segment_index';
import { InitSegmentReference, SegmentReference } from '../media/segment_reference';
import { WebmSegmentIndexParser } from '../media/webm_segment_index_parser';
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
  GetFrameNode,
} from './dash_parser';
import { MpdUtils } from './mpd_utils';

export class SegmentBase {
  /**
   * Creates an init segment reference from a Context object.
   *
   * @param {shaka.dash.DashParser.Context} context
   * @param {function(?shaka.dash.DashParser.InheritanceFrame):
   *    ?shaka.extern.xml.Node} callback
   * @param {shaka.extern.aesKey|undefined} aesKey
   * @return {shaka.media.InitSegmentReference}
   */
  static createInitSegment(context: DashParserContext, callback: GetFrameNode, aesKey?: AesKey) {
    const initialization = MpdUtils.inheritChild(context, callback, 'Initialization');
    if (!initialization) {
      return null;
    }

    let resolvedUris = context.representation!.getBaseUris();
    const uri = initialization.attributes['sourceURL'];
    if (uri) {
      resolvedUris = ManifestParserUtils.resolveUris(resolvedUris, [StringUtils.htmlUnescape(uri)]);
    }
    let startByte = 0;
    let endByte = null;
    const range = TXml.parseAttr(initialization, 'range', TXml.parseRange);
    if (range) {
      startByte = range.start;
      endByte = range.end;
    }

    const getUris = () => resolvedUris;
    const qualityInfo = SegmentBase.createQualityInfo(context);
    const ref = new InitSegmentReference(
      getUris,
      startByte,
      endByte,
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
   * Creates a new StreamInfo object.
   *
   * @param {shaka.dash.DashParser.Context} context
   * @param {shaka.dash.DashParser.RequestSegmentCallback} requestSegment
   * @param {shaka.extern.aesKey|undefined} aesKey
   * @return {shaka.dash.DashParser.StreamInfo}
   */
  static createStreamInfo(
    context: DashParserContext,
    requestSegment: DashParserRequestSegmentCallback,
    aesKey: AesKey
  ): DashParserStreamInfo {
    asserts.assert(context.representation?.segmentBase, 'Should only be called with SegmentBase');
    const unscaledPresentationTimeOffset =
      Number(MpdUtils.inheritAttribute(context, SegmentBase.fromInheritance_, 'presentationTimeOffset')) || 0;

    const timescaleStr = MpdUtils.inheritAttribute(context, SegmentBase.fromInheritance_, 'timescale');
    let timescale = 1;
    if (timescaleStr) {
      timescale = TXml.parsePositiveInt(timescaleStr) || 1;
    }

    const scaledPresentationTimeOffset = unscaledPresentationTimeOffset / timescale || 0;
    const initSegmentReference = SegmentBase.createInitSegment(context, SegmentBase.fromInheritance_, aesKey);

    // Throws an immediate error if the format is unsupported.
    SegmentBase.checkSegmentIndexRangeSupport_(context, initSegmentReference);

    // Direct fields of context will be reassigned by the parser before
    // generateSegmentIndex is called.  So we must make a shallow copy first,
    // and use that in the generateSegmentIndex callbacks.
    const shallowCopyOfContext = ObjectUtils.shallowCloneObject(context);

    return {
      generateSegmentIndex: () => {
        return SegmentBase.generateSegmentIndex_(
          shallowCopyOfContext,
          requestSegment,
          initSegmentReference!,
          scaledPresentationTimeOffset
        );
      },
    };
  }

  /**
   * Generate a SegmentIndex from a Context object.
   *
   * @param {shaka.dash.DashParser.Context} context
   * @param requestSegment
   * @param {shaka.media.InitSegmentReference} initSegmentReference
   * @param {number} scaledPresentationTimeOffset
   * @return {!Promise.<shaka.media.SegmentIndex>}
   * @private
   */
  private static generateSegmentIndex_(
    context: DashParserContext,
    requestSegment: DashParserRequestSegmentCallback,
    initSegmentReference: InitSegmentReference,
    scaledPresentationTimeOffset: number
  ): Promise<SegmentIndex> {
    const indexUris = SegmentBase.computeIndexUris_(context);
    const indexRange = SegmentBase.computeIndexRange_(context);
    asserts.assert(indexRange, 'Index range should not be null!');

    return SegmentBase.generateSegmentIndexFromUris(
      context,
      requestSegment,
      initSegmentReference,
      indexUris,
      indexRange!.start,
      indexRange!.end,
      scaledPresentationTimeOffset
    );
  }

  /**
   * Compute the URIs of the segment index from the container.
   *
   * @param {shaka.dash.DashParser.Context} context
   * @return {!Array.<string>}
   * @private
   */
  private static computeIndexUris_(context: DashParserContext) {
    const representationIndex = MpdUtils.inheritChild(context, SegmentBase.fromInheritance_, 'RepresentationIndex');

    let indexUris = context.representation!.getBaseUris();
    if (representationIndex) {
      const representationUri = StringUtils.htmlUnescape(representationIndex.attributes['sourceURL']);
      if (representationUri) {
        indexUris = ManifestParserUtils.resolveUris(indexUris, [representationUri]);
      }
    }

    return indexUris;
  }

  /**
   * Creates a SegmentIndex for the given URIs and context.
   *
   * @param {shaka.dash.DashParser.Context} context
   * @param {shaka.dash.DashParser.RequestSegmentCallback} requestSegment
   * @param {shaka.media.InitSegmentReference} initSegmentReference
   * @param {!Array.<string>} uris
   * @param {number} startByte
   * @param {?number} endByte
   * @param {number} scaledPresentationTimeOffset
   * @return {!Promise.<shaka.media.SegmentIndex>}
   */
  static async generateSegmentIndexFromUris(
    context: DashParserContext,
    requestSegment: DashParserRequestSegmentCallback,
    initSegmentReference: InitSegmentReference | null,
    uris: string[],
    startByte: number,
    endByte: number | null,
    scaledPresentationTimeOffset: number
  ): Promise<SegmentIndex> {
    // Unpack context right away, before we start an async process.
    // This immunizes us against changes to the context object later.
    const presentationTimeline = context.presentationTimeline;
    const fitLast = !context.dynamic || !context.periodInfo!.isLastPeriod;
    const periodStart = context.periodInfo!.start;
    const periodDuration = context.periodInfo!.duration;
    const containerType = context.representation!.mimeType.split('/')[1];

    // Create a local variable to bind to so we can set to null to help the GC.
    let localRequest: DashParserRequestSegmentCallback | null = requestSegment;
    let segmentIndex = null;
    const responses = [
      localRequest(uris, startByte, endByte, /* isInit= */ false),
      containerType == 'webm'
        ? localRequest(
            initSegmentReference!.getUris(),
            initSegmentReference!.startByte,
            initSegmentReference!.endByte!,
            true
          )
        : null,
    ];

    localRequest = null;
    const results = await Promise.all(responses);
    const indexData = results[0];
    const initData = results[1] || null;
    let references: SegmentReference[];
    const timestampOffset = periodStart - scaledPresentationTimeOffset;
    const appendWindowStart = periodStart;
    const appendWindowEnd = periodDuration ? periodStart + periodDuration : Infinity;

    if (containerType == 'mp4') {
      references = Mp4SegmentIndexParser.parse(
        indexData!,
        startByte,
        uris,
        initSegmentReference,
        timestampOffset,
        appendWindowStart,
        appendWindowEnd
      );
    } else {
      references = WebmSegmentIndexParser.parse(
        indexData!,
        initData!,
        uris,
        initSegmentReference!,
        timestampOffset,
        appendWindowStart,
        appendWindowEnd
      );
    }
    for (const ref of references) {
      ref.codecs = context.representation!.codecs;
      ref.mimeType = context.representation!.mimeType;
    }

    presentationTimeline.notifySegments(references);

    // Since containers are never updated, we don't need to store the
    // segmentIndex in the map.
    asserts.assert(!segmentIndex, 'Should not call generateSegmentIndex twice');

    segmentIndex = new SegmentIndex(references);
    if (fitLast) {
      segmentIndex.fit(appendWindowStart, appendWindowEnd, /* isNew= */ true);
    }
    return segmentIndex;
  }

  /**
   * Check if this type of segment index is supported.  This allows for
   * immediate errors during parsing, as opposed to an async error from
   * createSegmentIndex().
   *
   * Also checks for a valid byte range, which is not required for callers from
   * SegmentTemplate.
   *
   * @param {shaka.dash.DashParser.Context} context
   * @param {shaka.media.InitSegmentReference} initSegmentReference
   * @private
   */
  static checkSegmentIndexRangeSupport_(context: DashParserContext, initSegmentReference: InitSegmentReference | null) {
    SegmentBase.checkSegmentIndexSupport(context, initSegmentReference);

    const indexRange = SegmentBase.computeIndexRange_(context);
    if (!indexRange) {
      log.error(
        'SegmentBase does not contain sufficient segment information:',
        'the SegmentBase does not contain @indexRange',
        'or a RepresentationIndex element.',
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
   * Compute the byte range of the segment index from the container.
   *
   * @param {shaka.dash.DashParser.Context} context
   * @return {?{start: number, end: number}}
   * @private
   */
  static computeIndexRange_(context: DashParserContext) {
    const representationIndex = MpdUtils.inheritChild(context, SegmentBase.fromInheritance_, 'RepresentationIndex');
    const indexRangeElem = MpdUtils.inheritAttribute(context, SegmentBase.fromInheritance_, 'indexRange');

    let indexRange = TXml.parseRange(indexRangeElem || '');
    if (representationIndex) {
      indexRange = TXml.parseAttr(representationIndex, 'range', TXml.parseRange, indexRange)!;
    }
    return indexRange;
  }

  /**
   * Check if this type of segment index is supported.  This allows for
   * immediate errors during parsing, as opposed to an async error from
   * createSegmentIndex().
   *
   * @param {shaka.dash.DashParser.Context} context
   * @param {shaka.media.InitSegmentReference} initSegmentReference
   */
  static checkSegmentIndexSupport(context: DashParserContext, initSegmentReference: InitSegmentReference | null) {
    const ContentType = ManifestParserUtils.ContentType;

    const contentType = context.representation!.contentType;
    const containerType = context.representation!.mimeType.split('/')[1];
    if (contentType != ContentType.TEXT && containerType != 'mp4' && containerType != 'webm') {
      log.error('SegmentBase specifies an unsupported container type.', context.representation);
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.MANIFEST,
        ShakaError.Code.DASH_UNSUPPORTED_CONTAINER
      );
    }
    if (containerType == 'webm' && !initSegmentReference) {
      log.error(
        'SegmentBase does not contain sufficient segment information:',
        'the SegmentBase uses a WebM container,',
        'but does not contain an Initialization element.',
        context.representation
      );
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.MANIFEST,
        ShakaError.Code.DASH_WEBM_MISSING_INIT
      );
    }
  }

  /**
   * @param {?shaka.dash.DashParser.InheritanceFrame} frame
   * @return {?shaka.extern.xml.Node}
   * @private
   */
  static fromInheritance_(frame?: DashParserInheritanceFrame): XmlNode {
    return frame?.segmentBase!;
  }

  /**
   * Create a MediaQualityInfo object from a Context object.
   *
   * @param {!shaka.dash.DashParser.Context} context
   * @return {!shaka.extern.MediaQualityInfo}
   */
  static createQualityInfo(context: DashParserContext): MediaQualityInfo {
    const representation = context.representation!;
    return {
      bandwidth: context.bandwidth,
      audioSamplingRate: representation.audioSamplingRate,
      codecs: representation.codecs,
      contentType: representation.contentType,
      frameRate: representation.frameRate || null,
      height: representation.height || null,
      mimeType: representation.mimeType,
      channelsCount: representation.numChannels,
      pixelAspectRatio: representation.pixelAspectRatio || null,
      width: representation.width || null,
    };
  }
}
