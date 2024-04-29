/**
 * @typedef {{
*   id: number,
*   originalId: ?string,
*   groupId: ?string,
*   primary: boolean,
*   type: string,
*   mimeType: string,
*   codecs: string,
*   frameRate: (number|undefined),
*   pixelAspectRatio: (string|undefined),
*   hdr: (string|undefined),
*   videoLayout: (string|undefined),
*   kind: (string|undefined),
*   language: string,
*   originalLanguage: (?string|undefined),
*   label: ?string,
*   width: ?number,
*   height: ?number,
*   encrypted: boolean,
*   keyIds: !Set.<string>,
*   segments: !Array.<shaka.extern.SegmentDB>,
*   variantIds: !Array.<number>,
*   roles: !Array.<string>,
*   forced: boolean,
*   channelsCount: ?number,
*   audioSamplingRate: ?number,
*   spatialAudio: boolean,
*   closedCaptions: Map.<string, string>,
*   tilesLayout: (string|undefined),
*   external: boolean,
*   fastSwitching: boolean
* }}
*
* @property {number} id
*   The unique id of the stream.
* @property {?string} originalId
*   The original ID, if any, that appeared in the manifest.  For example, in
*   DASH, this is the "id" attribute of the Representation element.
* @property {?string} groupId
*   The ID of the stream's parent element. In DASH, this will be a unique
*   ID that represents the representation's parent adaptation element
* @property {boolean} primary
*   Whether the stream set was primary.
* @property {string} type
*   The type of the stream, 'audio', 'text', or 'video'.
* @property {string} mimeType
*   The MIME type of the stream.
* @property {string} codecs
*   The codecs of the stream.
* @property {(number|undefined)} frameRate
*   The Stream's framerate in frames per second.
* @property {(string|undefined)} pixelAspectRatio
*   The Stream's pixel aspect ratio
* @property {(string|undefined)} hdr
*   The Stream's HDR info
* @property {(string|undefined)} videoLayout
*   The Stream's video layout info.
* @property {(string|undefined)} kind
*   The kind of text stream; undefined for audio/video.
* @property {string} language
*   The language of the stream; '' for video.
* @property {(?string|undefined)} originalLanguage
*   The original language, if any, that appeared in the manifest.
* @property {?string} label
*   The label of the stream; '' for video.
* @property {?number} width
*   The width of the stream; null for audio/text.
* @property {?number} height
*   The height of the stream; null for audio/text.
* @property {boolean} encrypted
*   Whether this stream is encrypted.
* @property {!Set.<string>} keyIds
*   The key IDs this stream is encrypted with.
* @property {!Array.<shaka.extern.SegmentDB>} segments
*   An array of segments that make up the stream.
* @property {!Array.<number>} variantIds
*   An array of ids of variants the stream is a part of.
* @property {!Array.<string>} roles
*   The roles of the stream as they appear on the manifest,
*   e.g. 'main', 'caption', or 'commentary'.
* @property {boolean} forced
*   Whether the stream set was forced.
* @property {?number} channelsCount
*   The channel count information for the audio stream.
* @property {?number} audioSamplingRate
*   Specifies the maximum sampling rate of the content.
* @property {boolean} spatialAudio
*   Whether the stream set has spatial audio.
* @property {Map.<string, string>} closedCaptions
*   A map containing the description of closed captions, with the caption
*   channel number (CC1 | CC2 | CC3 | CC4) as the key and the language code
*   as the value. If the channel number is not provided by the description,
*   we'll set a 0-based index as the key. If the language code is not
*   provided by the description we'll set the same value as channel number.
*   Example: {'CC1': 'eng'; 'CC3': 'swe'}, or {'1', 'eng'; '2': 'swe'}, etc.
* @property {(string|undefined)} tilesLayout
*   The value is a grid-item-dimension consisting of two positive decimal
*   integers in the format: column-x-row ('4x3'). It describes the arrangement
*   of Images in a Grid. The minimum valid LAYOUT is '1x1'.
* @property {boolean} external
*   Indicate if the stream was added externally.
*   Eg: external text tracks.
* @property {boolean} fastSwitching
*   Indicate if the stream should be used for fast switching.
*/
export interface StreamDB {
  id: number;
  originalId: string | null;
  groupId: string | null;
  primary: boolean;
  type: string;
  mimeType: string;
  codecs: string;
  frameRate: number | null;
  pixelAspectRatio: string | null;
  hdr: string | null;
  videoLayout: string | null;
  kind: string | null;
  language: string;
  originalLanguage: string | null;
  label: string | null;
  width: number | null;
  height: number | null;
  encrypted: boolean;
  keyIds: Set<string>;
  segments: Array<SegmentDB>;
  variantIds: Array<number>;
  roles: Array<string>
  forced: boolean;
  channelsCount: number | null;
  audioSamplingRate: number | null;
  spatialAudio: boolean;
  closedCaptions: Map<string, string>;
  tilesLayout: string | null;
  external: boolean;
  fastSwitching: boolean;
}



/**
 * @typedef {{
*   initSegmentKey: ?number,
*   startTime: number,
*   endTime: number,
*   appendWindowStart: number,
*   appendWindowEnd: number,
*   timestampOffset: number,
*   tilesLayout: ?string,
*   pendingSegmentRefId: (string|undefined),
*   pendingInitSegmentRefId: (string|undefined),
*   dataKey: number,
*   mimeType: ?string,
*   codecs: ?string
* }}
*
* @property {?number} initSegmentKey
*   The storage key where the init segment is found; null if no init segment.
* @property {number} startTime
*   The start time of the segment in the presentation timeline.
* @property {number} endTime
*   The end time of the segment in the presentation timeline.
* @property {number} appendWindowStart
*   A start timestamp before which media samples will be truncated.
* @property {number} appendWindowEnd
*   An end timestamp beyond which media samples will be truncated.
* @property {number} timestampOffset
*   An offset which MediaSource will add to the segment's media timestamps
*   during ingestion, to align to the presentation timeline.
* @property {?string} tilesLayout
*   The value is a grid-item-dimension consisting of two positive decimal
*   integers in the format: column-x-row ('4x3'). It describes the
*   arrangement of Images in a Grid. The minimum valid LAYOUT is '1x1'.
* @property {(string|undefined)} pendingSegmentRefId
*   Contains an id that identifies what the segment was, originally. Used to
*   coordinate where segments are stored, during the downloading process.
*   If this field is non-null, it's assumed that the segment is not fully
*   downloaded.
* @property {(string|undefined)} pendingInitSegmentRefId
*   Contains an id that identifies what the init segment was, originally.
*   Used to coordinate where init segments are stored, during the downloading
*   process.
*   If this field is non-null, it's assumed that the init segment is not fully
*   downloaded.
* @property {number} dataKey
*   The key to the data in storage.
* @property {?string} mimeType
*   The mimeType of the segment.
* @property {?string} codecs
*   The codecs of the segment.
*/
export interface SegmentDB {
  initSegmentKey: number | null;
  startTime: number;
  endTime: number;
  appendWindowStart: number;
  appendWindowEnd: number;
  timestampOffset: number;
  tilesLayout: string | null;
  pendingSegmentRefId: string | null;
  pendingInitSegmentRefId: string | null;
  dataKey: number;
  mimeType: string | null;
  codecs: string | null;

}