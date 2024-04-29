import { StreamDB } from "./offline";

/**
 * @typedef {{
*   initData: !Uint8Array,
*   initDataType: string,
*   keyId: ?string
* }}
*
* @description
* Explicit initialization data, which override any initialization data in the
* content. The initDataType values and the formats that they correspond to
* are specified {@link https://bit.ly/EmeInitTypes here}.
*
* @property {!Uint8Array} initData
*   Initialization data in the format indicated by initDataType.
* @property {string} initDataType
*   A string to indicate what format initData is in.
* @property {?string} keyId
*   The key Id that corresponds to this initData.
*
* @exportDoc
*/
export interface InitDataOverride {
  initData: Uint8Array;
  initDataType: string;
  keyId?: string;
}

/**
 * @typedef {{
*   keySystem: string,
*   encryptionScheme: string,
*   licenseServerUri: string,
*   distinctiveIdentifierRequired: boolean,
*   persistentStateRequired: boolean,
*   audioRobustness: string,
*   videoRobustness: string,
*   serverCertificate: Uint8Array,
*   serverCertificateUri: string,
*   sessionType: string,
*   initData: Array.<!shaka.extern.InitDataOverride>,
*   keyIds: Set.<string>
* }}
*
* @description
* DRM configuration for a single key system.
*
* @property {string} keySystem
*   <i>Required.</i> <br>
*   The key system, e.g., "com.widevine.alpha".
* @property {string} encryptionScheme
*   <i>Required.</i> <br>
*   The encryption scheme, e.g., "cenc", "cbcs", "cbcs-1-9".
* @property {string} licenseServerUri
*   <i>Filled in by DRM config if missing.</i> <br>
*   The license server URI.
* @property {boolean} distinctiveIdentifierRequired
*   <i>Defaults to false.  Can be filled in by advanced DRM config.</i> <br>
*   True if the application requires the key system to support distinctive
*   identifiers.
* @property {boolean} persistentStateRequired
*   <i>Defaults to false.  Can be filled in by advanced DRM config.</i> <br>
*   True if the application requires the key system to support persistent
*   state, e.g., for persistent license storage.
* @property {string} sessionType
*   <i>Defaults to 'temporary' if Shaka wasn't initiated for storage.
*   Can be filled in by advanced DRM config sessionType parameter.</i> <br>
* @property {string} audioRobustness
*   <i>Defaults to '', e.g., no specific robustness required.  Can be filled in
*   by advanced DRM config.</i> <br>
*   A key-system-specific string that specifies a required security level.
* @property {string} videoRobustness
*   <i>Defaults to '', e.g., no specific robustness required.  Can be filled in
*   by advanced DRM config.</i> <br>
*   A key-system-specific string that specifies a required security level.
* @property {Uint8Array} serverCertificate
*   <i>Defaults to null, e.g., certificate will be requested from the license
*   server if required.  Can be filled in by advanced DRM config.</i> <br>
*   A key-system-specific server certificate used to encrypt license requests.
*   Its use is optional and is meant as an optimization to avoid a round-trip
*   to request a certificate.
* @property {string} serverCertificateUri
*   <i>Defaults to '', e.g., server certificate will be requested from the
*   given URI if serverCertificate is not provided. Can be filled in by
*   advanced DRM config.</i>
* @property {Array.<!shaka.extern.InitDataOverride>} initData
*   <i>Defaults to [], e.g., no override.</i> <br>
*   A list of initialization data which override any initialization data found
*   in the content.  See also shaka.extern.InitDataOverride.
* @property {Set.<string>} keyIds
*   <i>Defaults to the empty Set</i> <br>
*   If not empty, contains the default key IDs for this key system, as
*   lowercase hex strings.
* @exportDoc
*/
export interface DrmInfo {
  keySystem: string,
  encryptionScheme: string,
  licenseServerUri: string,
  distinctiveIdentifierRequired: boolean,
  persistentStateRequired: boolean,
  audioRobustness: string,
  videoRobustness: string,
  serverCertificate: Uint8Array,
  serverCertificateUri: string,
  sessionType: string,
  initData: Array<InitDataOverride>,
  keyIds: Set<string>
}




/**
 * Creates a SegmentIndex; returns a Promise that resolves after the
 * SegmentIndex has been created.
 *
 * @typedef {function(): !Promise}
 * @exportDoc
 */
type CreateSegmentIndexFunction = () => Promise<void>;


/**
 * @typedef {{
 *   id: number,
 *   originalId: ?string,
 *   groupId: ?string,
 *   createSegmentIndex: shaka.extern.CreateSegmentIndexFunction,
 *   closeSegmentIndex: (function()|undefined),
 *   segmentIndex: shaka.media.SegmentIndex,
 *   mimeType: string,
 *   codecs: string,
 *   frameRate: (number|undefined),
 *   pixelAspectRatio: (string|undefined),
 *   hdr: (string|undefined),
 *   videoLayout: (string|undefined),
 *   bandwidth: (number|undefined),
 *   width: (number|undefined),
 *   height: (number|undefined),
 *   kind: (string|undefined),
 *   encrypted: boolean,
 *   drmInfos: !Array.<shaka.extern.DrmInfo>,
 *   keyIds: !Set.<string>,
 *   language: string,
 *   originalLanguage: ?string,
 *   label: ?string,
 *   type: string,
 *   primary: boolean,
 *   trickModeVideo: ?shaka.extern.Stream,
 *   emsgSchemeIdUris: ?Array.<string>,
 *   roles: !Array.<string>,
 *   accessibilityPurpose: ?shaka.media.ManifestParser.AccessibilityPurpose,
 *   forced: boolean,
 *   channelsCount: ?number,
 *   audioSamplingRate: ?number,
 *   spatialAudio: boolean,
 *   closedCaptions: Map.<string, string>,
 *   tilesLayout: (string|undefined),
 *   matchedStreams:
 *      (!Array.<shaka.extern.Stream>|!Array.<shaka.extern.StreamDB>|
 *      undefined),
 *   mssPrivateData: (shaka.extern.MssPrivateData|undefined),
 *   external: boolean,
 *   fastSwitching: boolean,
 *   fullMimeTypes: !Set.<string>
 * }}
 *
 * @description
 * A Stream object describes a single stream (segmented media data).
 *
 * @property {number} id
 *   <i>Required.</i> <br>
 *   A unique ID among all Stream objects within the same Manifest.
 * @property {?string} originalId
 *   <i>Optional.</i> <br>
 *   The original ID, if any, that appeared in the manifest.  For example, in
 *   DASH, this is the "id" attribute of the Representation element.  In HLS,
 *   this is the "NAME" attribute.
 * @property {?string} groupId
 *   <i>Optional.</i> <br>
 *   The ID of the stream's parent element. In DASH, this will be a unique
 *   ID that represents the representation's parent adaptation element
 * @property {shaka.extern.CreateSegmentIndexFunction} createSegmentIndex
 *   <i>Required.</i> <br>
 *   Creates the Stream's segmentIndex (asynchronously).
 * @property {(function()|undefined)} closeSegmentIndex
 *   <i>Optional.</i> <br>
 *   Closes the Stream's segmentIndex.
 * @property {shaka.media.SegmentIndex} segmentIndex
 *   <i>Required.</i> <br>
 *   May be null until createSegmentIndex() is complete.
 * @property {string} mimeType
 *   <i>Required.</i> <br>
 *   The Stream's MIME type, e.g., 'audio/mp4', 'video/webm', or 'text/vtt'.
 *   In the case of a stream that adapts between different periods with
 *   different MIME types, this represents only the first period.
 * @property {string} codecs
 *   <i>Defaults to '' (i.e., unknown / not needed).</i> <br>
 *   The Stream's codecs, e.g., 'avc1.4d4015' or 'vp9', which must be
 *   compatible with the Stream's MIME type. <br>
 *   In the case of a stream that adapts between different periods with
 *   different codecs, this represents only the first period.
 *   See {@link https://tools.ietf.org/html/rfc6381}
 * @property {(number|undefined)} frameRate
 *   <i>Video streams only.</i> <br>
 *   The Stream's framerate in frames per second
 * @property {(string|undefined)} pixelAspectRatio
 *   <i>Video streams only.</i> <br>
 *   The Stream's pixel aspect ratio
 * @property {(string|undefined)} hdr
 *   <i>Video streams only.</i> <br>
 *   The Stream's HDR info
 * @property {(string|undefined)} videoLayout
 *   <i>Video streams only.</i> <br>
 *   The Stream's video layout info.
 * @property {(number|undefined)} bandwidth
 *   <i>Audio and video streams only.</i> <br>
 *   The stream's required bandwidth in bits per second.
 * @property {(number|undefined)} width
 *   <i>Video streams only.</i> <br>
 *   The stream's width in pixels.
 * @property {(number|undefined)} height
 *   <i>Video streams only.</i> <br>
 *   The stream's height in pixels.
 * @property {(string|undefined)} kind
 *   <i>Text streams only.</i> <br>
 *   The kind of text stream.  For example, 'caption' or 'subtitle'.
 *   @see https://bit.ly/TextKind
 * @property {boolean} encrypted
 *   <i>Defaults to false.</i><br>
 *   True if the stream is encrypted.
 * @property {!Array.<!shaka.extern.DrmInfo>} drmInfos
 *   <i>Defaults to [] (i.e., no DRM).</i> <br>
 *   An array of DrmInfo objects which describe DRM schemes are compatible with
 *   the content.
 * @property {!Set.<string>} keyIds
 *   <i>Defaults to empty (i.e., unencrypted or key ID unknown).</i> <br>
 *   The stream's key IDs as lowercase hex strings. These key IDs identify the
 *   encryption keys that the browser (key system) can use to decrypt the
 *   stream.
 * @property {string} language
 *   The Stream's language, specified as a language code. <br>
 *   Audio stream's language must be identical to the language of the containing
 *   Variant.
 * @property {?string} originalLanguage
 *   <i>Optional.</i> <br>
 *   The original language, if any, that appeared in the manifest.
 * @property {?string} label
 *   The Stream's label, unique text that should describe the audio/text track.
 * @property {string} type
 *   <i>Required.</i> <br>
 *   Content type (e.g. 'video', 'audio' or 'text', 'image')
 * @property {boolean} primary
 *   <i>Defaults to false.</i> <br>
 *   True indicates that the player should use this Stream over others if user
 *   preferences cannot be met.  The player may still use another Variant to
 *   meet user preferences.
 * @property {?shaka.extern.Stream} trickModeVideo
 *   <i>Video streams only.</i> <br>
 *   An alternate video stream to use for trick mode playback.
 * @property {?Array.<string>} emsgSchemeIdUris
 *   <i>Defaults to empty.</i><br>
 *   Array of registered emsg box scheme_id_uri that should result in
 *   Player events.
 * @property {!Array.<string>} roles
 *   The roles of the stream as they appear on the manifest,
 *   e.g. 'main', 'caption', or 'commentary'.
 * @property {?shaka.media.ManifestParser.AccessibilityPurpose}
 *     accessibilityPurpose
 *   The DASH accessibility descriptor, if one was provided for this stream.
 * @property {boolean} forced
 *   <i>Defaults to false.</i> <br>
 *   Whether the stream set was forced
 * @property {?number} channelsCount
 *   The channel count information for the audio stream.
 * @property {?number} audioSamplingRate
 *   Specifies the maximum sampling rate of the content.
 * @property {boolean} spatialAudio
 *   <i>Defaults to false.</i> <br>
 *   Whether the stream set has spatial audio
 * @property {Map.<string, string>} closedCaptions
 *   A map containing the description of closed captions, with the caption
 *   channel number (CC1 | CC2 | CC3 | CC4) as the key and the language code
 *   as the value. If the channel number is not provided by the description,
 *   we'll set a 0-based index as the key. If the language code is not
 *   provided by the description we'll set the same value as channel number.
 *   Example: {'CC1': 'eng'; 'CC3': 'swe'}, or {'1', 'eng'; '2': 'swe'}, etc.
 * @property {(string|undefined)} tilesLayout
 *   <i>Image streams only.</i> <br>
 *   The value is a grid-item-dimension consisting of two positive decimal
 *   integers in the format: column-x-row ('4x3'). It describes the arrangement
 *   of Images in a Grid. The minimum valid LAYOUT is '1x1'.
 * @property {(!Array.<shaka.extern.Stream>|!Array.<shaka.extern.StreamDB>|
 *   undefined)} matchedStreams
 *   The streams in all periods which match the stream. Used for Dash.
 * @property {(shaka.extern.MssPrivateData|undefined)} mssPrivateData
 *   <i>Microsoft Smooth Streaming only.</i> <br>
 *   Private MSS data that is necessary to be able to do transmuxing.
 * @property {boolean} external
 *   Indicate if the stream was added externally.
 *   Eg: external text tracks.
 * @property {boolean} fastSwitching
 *   Indicate if the stream should be used for fast switching.
 * @property {!Set.<string>} fullMimeTypes
 *   A set of full MIME types (e.g. MIME types plus codecs information), that
 *   represents the types used in each period of the original manifest.
 *   Meant for being used by compatibility checking, such as with
 *   MediaSource.isTypeSupported.
 *
 * @exportDoc
 */
export interface Stream {
  id: number;
  originalId?: string;
  groupId?: string;
  createSegmentIndex: CreateSegmentIndexFunction;
  closeSegmentIndex: () => void;
  // TODO: SegmentIndex
  segmentIndex: shaka.media.SegmentIndex;
  mimeType: string;
  codecs: string;
  frameRate: number | undefined;
  pixelAspectRatio: string | undefined;
  hdr: string | undefined;
  videoLayout: string | undefined;
  bandwidth: number | undefined;
  width: number | undefined;
  height: number | undefined;
  kind: string | undefined;
  encrypted: boolean;
  drmInfos: Array<DrmInfo>;
  keyIds: Set<string>;
  language: string;
  originalLanguage?: string;
  label?: string;
  type: string;
  primary: boolean;
  trickModeVideo?: Stream;
  emsgSchemeIdUris?: Array<string>;
  roles: Array<string>;
  // TODO
  accessibilityPurpose?: shaka.media.ManifestParser.AccessibilityPurpose;
  forced: boolean;
  channelsCount?: number;
  audioSamplingRate?: number;
  spatialAudio: boolean;
  closedCaptions: Map<string, string>;
  tilesLayout?: string;
  matchedStreams?: Array<Stream> | Array<StreamDB>;
  mssPrivateData?: MssPrivateData;
  external: boolean;
  fastSwitching: boolean;
  fullMimeTypes: Set<string>;
}

export interface Variant {
  id: number;
  language: string;
  disabledUntilTime: number;
  primary: boolean;
  audio: Stream;
  video: Stream;
  bandwidth: number;
  allowedByApplication: boolean;
  allowedByKeySystem: boolean;
  decodingInfos: Array<MediaCapabilitiesDecodingInfo>;
}


/**
 * @typedef {{
*   duration: number,
*   timescale: number,
*   codecPrivateData: ?string
* }}
*
* @description
* Private MSS data that is necessary to be able to do transmuxing.
*
* @property {number} duration
*   <i>Required.</i> <br>
*   MSS Stream duration.
* @property {number} timescale
*   <i>Required.</i> <br>
*   MSS timescale.
* @property {?string} codecPrivateData
*   MSS codecPrivateData.
*
* @exportDoc
*/
export interface MssPrivateData {
  duration: number;
  timescale: number;
  codecPrivateData?: string;
}
