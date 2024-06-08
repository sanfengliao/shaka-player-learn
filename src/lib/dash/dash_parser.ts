import { XmlNode } from '../../externs/shaka';
import { AesKey, DrmInfo, Stream } from '../../externs/shaka/manifest';
import { PresentationTimeline } from '../media/presentation_timeline';
import { SegmentIndex } from '../media/segment_index';

export class DashParser {
  private static SCTE214_ = 'urn:scte:dash:scte214-extensions';
}

export interface DashParserPatchContext {
  // ID of the original MPD file.
  mpdId: string;
  // Specifies the type of the dash manifest i.e. "static"
  type: string;
  // Media presentation duration, or null if unknown.
  mediaPresentationDuration: number;
  /**
   * Profiles of DASH are defined to enable interoperability and the
   * signaling of the use of features.
   */
  profiles: string[];
  // Specifies the total availabilityTimeOffset of the segment.
  availabilityTimeOffset: number;
  // An array of absolute base URIs.
  getBaseUris?: () => string[];
  // Time when manifest has been published, in seconds.
  publishTime: number;
}

export type DashParserRequestSegmentCallback = (
  a: string[],
  b?: number,
  c?: number,
  d?: boolean
) => Promise<BufferSource>;

/**
 * A collection of elements and properties which are inherited across levels
 * of a DASH manifest.
 */

export interface DashParserInheritanceFrame {
  // The XML node for SegmentBase.
  segmentBase?: XmlNode;
  // The XML node for SegmentList.
  segmentList?: XmlNode;
  // The XML node for SegmentTemplate.
  segmentTemplate?: XmlNode;
  // Function than returns an array of absolute base URIs for the frame.
  getBaseUris: () => string[];
  // The inherited width value.
  width?: number;
  // The inherited height value.
  height?: number;
  // The inherited media type.
  mimeType: string;
  // The inherited codecs value.
  codecs: string;
  // The inherited framerate value.
  frameRate?: number;
  // The inherited pixel aspect ratio value.
  emsgSchemeIdUris: string[];
  // The ID of the element.
  id?: string;
  // The original language of the element.
  language?: string;
  // The number of audio channels, or null if unknown.
  numChannels?: number;
  // Specifies the maximum sampling rate of the content, or null if unknown.
  audioSamplingRate?: number;
  // Specifies the total availabilityTimeOffset of the segment, or 0 if unknown.
  availabilityTimeOffset: number;
  // Specifies the file where the init segment is located, or null.
  initialization?: string | null;
  // AES-128 Content protection key
  aesKey?: AesKey;
  /**
   * Specifies the cadence of independent segments in Segment Sequence
   * Representation.
   */
  segmentSequenceCadence: number;
}

/**
 * @description
 * Contains context data for the streams.  This is designed to be
 * shallow-copyable, so the parser must overwrite (not modify) each key as the
 * parser moves through the manifest and the parsing context changes.
 *
 */
export interface DashParserContext {
  // True if the MPD is dynamic (not all segments available at once)
  dynamic: boolean;
  // The PresentationTimeline.
  presentationTimeline: PresentationTimeline;
  period?: DashParserInheritanceFrame;
  // The Period info for the current Period.
  periodInfo?: DashParserPeriodInfo;
  //  The inheritance from the AdaptationSet element.
  adaptationSet?: DashParserInheritanceFrame;
  // The inheritance from the Representation element.
  representation?: DashParserInheritanceFrame;
  // The bandwidth of the Representation, or zero if missing.
  bandwidth: number;
  // True if the warning about SegmentURL@indexRange has been printed.
  indexRangeWarningGiven: boolean;
  //  The sum of the availabilityTimeOffset values that apply to the element.
  availabilityTimeOffset: number;
  /**
   * Profiles of DASH are defined to enable interoperability and the signaling
   * of the use of features.
   */
  profiles: string[];
  //  Media presentation duration, or null if unknown.
  mediaPresentationDuration?: number | null;
}

/**
 * @description
 * Contains information about a Period element.
 */
export interface DashParserPeriodInfo {
  // The start time of the period.
  start: number;
  /**
   * The duration of the period; or null if the duration is not given.  This
   * will be non-null for all periods except the last.
   */
  duration?: number;
  // The XML Node for the Period.
  node: XmlNode;
  // Whether this Period is the last one in the manifest.
  isLastPeriod: boolean;
}

export interface DashParserAdaptationInfo {
  // The unique ID of the adaptation set.
  id: string;
  // The content type of the AdaptationSet.
  contentType: string;
  //  The language of the AdaptationSet.
  language: string;
  //  Whether the AdaptationSet has the 'main' type.
  main: boolean;
  //  The streams this AdaptationSet contains.
  stream: Stream[];
  // The DRM info for the AdaptationSet.
  drmInfo: DrmInfo[];
  /**
   * If non-null, this AdaptationInfo represents trick mode tracks.  This
   * property is the ID of the normal AdaptationSet these tracks should be
   * associated with.
   */
  trickModeFor?: string;
  // An array of the IDs of the Representations this AdaptationSet contains.
  representationIds: string[];
}

// An async function which generates and returns a SegmentIndex.
export type DashParserGenerateSegmentIndexFunction = () => Promise<SegmentIndex>;

/**
 * Contains information about a Stream. This is passed from the createStreamInfo
 * methods.
 */
export interface DashParserStreamInfo {
  // An async function to create the SegmentIndex for the stream.
  generateSegmentIndex: DashParserGenerateSegmentIndexFunction;
}
