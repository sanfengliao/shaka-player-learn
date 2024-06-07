/**

*/
export interface StreamDB {
  // The unique id of the stream.
  id: number;
  /**
   * The original ID, if any, that appeared in the manifest.  For example, in
   * DASH, this is the "id" attribute of the Representation element.
   */
  originalId?: string;
  /**
   * The ID of the stream's parent element. In DASH, this will be a unique
   * ID that represents the representation's parent adaptation element
   */
  groupId?: string;
  /**
   *  Whether the stream set was primary.
   */
  primary: boolean;
  /**
   * The type of the stream, 'audio', 'text', or 'video'.
   */
  type: string;
  /**
   * The MIME type of the stream.
   */
  mimeType: string;
  /**
   * The codecs of the stream.
   */
  codecs: string;
  // The Stream's framerate in frames per second.
  frameRate?: number;
  // The Stream's pixel aspect ratio
  pixelAspectRatio?: string;
  // The Stream's HDR info
  hdr?: string;
  // The Stream's color gamut info
  colorGamut?: string;
  // The Stream's video layout info.
  videoLayout?: string;
  // The kind of text stream; undefined for audio/video.
  kind?: string;
  // The language of the stream; '' for video.
  language: string;
  // The original language, if any, that appeared in the manifest.
  originalLanguage?: string;
  // The label of the stream; '' for video.
  label?: string;
  // The width of the stream; null for audio/text.
  width?: number;
  // The height of the stream; null for audio/text.
  height?: number;
  // Whether this stream is encrypted.
  encrypted: boolean;
  // The key IDs this stream is encrypted with.
  keyIds: Set<string>;
  // An array of segments that make up the stream.
  segments: Array<SegmentDB>;
  // An array of ids of variants the stream is a part of.
  variantIds: Array<number>;
  /**
   * The roles of the stream as they appear on the manifest,
   * e.g. 'main', 'caption', or 'commentary'.
   */
  roles: Array<string>;
  // Whether the stream set was forced.
  forced: boolean;
  // The channel count information for the audio stream.
  channelsCount?: number;
  // Specifies the maximum sampling rate of the content.
  audioSamplingRate?: number;
  // Whether the stream set has spatial audio.
  spatialAudio: boolean;
  /**
   * A map containing the description of closed captions, with the caption
   * channel number (CC1 | CC2 | CC3 | CC4) as the key and the language code
   * as the value. If the channel number is not provided by the description,
   * we'll set a 0-based index as the key. If the language code is not
   * provided by the description we'll set the same value as channel number.
   * Example: {'CC1': 'eng'; 'CC3': 'swe'}, or {'1', 'eng'; '2': 'swe'}, etc.
   */
  closedCaptions: Map<string, string>;
  /**
   * The value is a grid-item-dimension consisting of two positive decimal
   * integers in the format: column-x-row ('4x3'). It describes the arrangement
   * of Images in a Grid. The minimum valid LAYOUT is '1x1'.
   */
  tilesLayout?: string;
  /**
   * Indicate if the stream was added externally.
   * Eg: external text tracks
   */
  external: boolean;
  /**
   * Indicate if the stream should be used for fast switching.
   */
  fastSwitching: boolean;
}
export interface SegmentDB {
  // The storage key where the init segment is found; null if no init segment.
  initSegmentKey?: number;
  // The start time of the segment in the presentation timeline.
  startTime: number;
  // The end time of the segment in the presentation timeline.
  endTime: number;
  // A start timestamp before which media samples will be truncated.
  appendWindowStart: number;
  // An end timestamp beyond which media samples will be truncated.
  appendWindowEnd: number;
  /**
   * An offset which MediaSource will add to the segment's media timestamps
   * during ingestion, to align to the presentation timeline.
   */
  timestampOffset: number;
  /**
   * The value is a grid-item-dimension consisting of two positive decimal
   * integers in the format: column-x-row ('4x3'). It describes the
   * arrangement of Images in a Grid. The minimum valid LAYOUT is '1x1'.
   */
  tilesLayout?: string;
  /**
   * Contains an id that identifies what the segment was, originally. Used to
   * coordinate where segments are stored, during the downloading process.
   * If this field is non-null, it's assumed that the segment is not fully
   * downloaded.
   */
  pendingSegmentRefId?: string;
  /**
   * Contains an id that identifies what the init segment was, originally.
   * Used to coordinate where init segments are stored, during the downloading
   * process.
   * If this field is non-null, it's assumed that the init segment is not fully
   * downloaded.
   */
  pendingInitSegmentRefId?: string;
  /**
   *  The key to the data in storage.
   */
  dataKey: number;
  /**
   * The mimeType of the segment.
   */
  mimeType?: string;
  /**
   * The codecs of the segment.
   */
  codecs?: string;
}
