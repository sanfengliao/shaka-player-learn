import { AutoShowText } from '../../lib/config/auto_show_text';
import { RetryParameters } from './net';

export interface AdvancedAbrConfiguration {
  /**
   * Minimum number of bytes sampled before we trust the estimate.  If we have
   * not sampled much data, our estimate may not be accurate enough to trust.
   */
  minTotalBytes: number;
  /**
   * Minimum number of bytes, under which samples are discarded.  Our models
   * do not include latency information, so connection startup time (time to
   * first byte) is considered part of the download time.  Because of this, we
   * should ignore very small downloads which would cause our estimate to be
   * too low.
   */
  minBytes: number;
  /**
   * The quantity of prior samples (by weight) used when creating a new
   * estimate, in seconds.  Those prior samples make up half of the
   * new estimate.
   */
  fastHalfLife: number;
  /**
   * The quantity of prior samples (by weight) used when creating a new
   * estimate, in seconds.  Those prior samples make up half of the
   * new estimate.
   */
  slowHalfLife: number;
}

/**
 * @description
 * An object describing application restrictions on what tracks can play.  All
 * restrictions must be fulfilled for a track to be playable/selectable.
 * The restrictions system behaves somewhat differently at the ABR level and the
 * player level, so please refer to the documentation for those specific
 * settings.
 */
export interface Restrictions {
  // The minimum width of a video track, in pixels.
  minWidth: number;
  // The maximum width of a video track, in pixels.
  maxWidth: number;
  // The minimum height of a video track, in pixels.
  minHeight: number;
  // The maximum height of a video track, in pixels.
  maxHeight: number;
  /**
   * The minimum number of total pixels in a video track (i.e.
   * <code>width * height</code>).
   */
  minPixels: number;
  /**
   * The maximum number of total pixels in a video track (i.e.
   * <code>width * height</code>).
   */
  maxPixels: number;
  /**
   * The minimum framerate of a variant track.
   */
  minFrameRate: number;
  /**
   * The maximum framerate of a variant track.
   */
  maxFrameRate: number;
  /**
   * The minimum bandwidth of a variant track, in bit/sec.
   */
  minBandwidth: number;
  /**
   * The maximum bandwidth of a variant track, in bit/sec.
   */
  maxBandwidth: number;
  /**
   * The minimum channels count of a variant track.
   */
  minChannelsCount: number;
  /**
   * The maximum channels count of a variant track.
   */
  maxChannelsCount: number;
}

/**
 * @typedef {{
 *   enabled: boolean,
 *   useNetworkInformation: boolean,
 *   defaultBandwidthEstimate: number,
 *   restrictions: shaka.extern.Restrictions,
 *   switchInterval: number,
 *   bandwidthUpgradeTarget: number,
 *   bandwidthDowngradeTarget: number,
 *   advanced: shaka.extern.AdvancedAbrConfiguration,
 *   restrictToElementSize: boolean,
 *   restrictToScreenSize: boolean,
 *   ignoreDevicePixelRatio: boolean,
 *   clearBufferSwitch: boolean,
 *   safeMarginSwitch: number
 * }}
 *
 * @property {boolean} enabled
 *   If true, enable adaptation by the current AbrManager.  Defaults to true.
 * @property {boolean} useNetworkInformation
 *   If true, use Network Information API in the current AbrManager.
 *   Defaults to true.
 * @property {number} defaultBandwidthEstimate
 *   The default bandwidth estimate to use if there is not enough data, in
 *   bit/sec.
 * @property {shaka.extern.Restrictions} restrictions
 *   The restrictions to apply to ABR decisions.  These are "soft" restrictions.
 *   Any track that fails to meet these restrictions will not be selected
 *   automatically, but will still appear in the track list and can still be
 *   selected via <code>selectVariantTrack()</code>.  If no tracks meet these
 *   restrictions, AbrManager should not fail, but choose a low-res or
 *   low-bandwidth variant instead.  It is the responsibility of AbrManager
 *   implementations to follow these rules and implement this behavior.
 * @property {number} switchInterval
 *   The minimum amount of time that must pass between switches, in
 *   seconds. This keeps us from changing too often and annoying the user.
 * @property {number} bandwidthUpgradeTarget
 *   The fraction of the estimated bandwidth which we should try to use when
 *   upgrading.
 * @property {number} bandwidthDowngradeTarget
 *   The largest fraction of the estimated bandwidth we should use. We should
 *   downgrade to avoid this.
 * @property {shaka.extern.AdvancedAbrConfiguration} advanced
 *   Advanced ABR configuration
 * @property {boolean} restrictToElementSize
 *   If true, restrict the quality to media element size.
 *   Note: The use of ResizeObserver is required for it to work properly. If
 *   true without ResizeObserver, it behaves as false.
 *   Defaults false.
 * @property {boolean} restrictToScreenSize
 *   If true, restrict the quality to screen size.
 *   Defaults false.
 * @property {boolean} ignoreDevicePixelRatio
 *   If true,device pixel ratio is ignored when restricting the quality to
 *   media element size or screen size.
 *   Defaults false.
 * @property {boolean} clearBufferSwitch
 *   If true, the buffer will be cleared during the switch.
 *   The default automatic behavior is false to have a smoother transition.
 *   On some device it's better to clear buffer.
 *   Defaults false.
 * @property {number} safeMarginSwitch
 *   Optional amount of buffer (in seconds) to
 *   retain when clearing the buffer during the automatic switch.
 *   Useful for switching variant quickly without causing a buffering event.
 *   Defaults to 0 if not provided. Ignored if clearBuffer is false.
 *   Can cause hiccups on some browsers if chosen too small, e.g.
 *   The amount of two segments is a fair minimum to consider as safeMargin
 *   value.
 * @exportDoc
 */
export interface AbrConfiguration {
  /**
   * If true, enable adaptation by the current AbrManager.  Defaults to true.
   */
  enabled: boolean;
  /**
   * If true, use the Network Information API in the current AbrManager, if it
   * is available in the browser environment.  If the Network Information API is
   * used, Shaka Player will ignore the defaultBandwidthEstimate config.
   * Defaults to true.
   */
  useNetworkInformation: boolean;
  /**
   * The default bandwidth estimate to use if there is not enough data, in
   * bit/sec.  Only used if useNetworkInformation is false, or if the Network
   * Information API is not available.
   */
  defaultBandwidthEstimate: number;
  /**
   * The restrictions to apply to ABR decisions.  These are "soft" restrictions.
   * Any track that fails to meet these restrictions will not be selected
   * automatically, but will still appear in the track list and can still be
   * selected via <code>selectVariantTrack()</code>.  If no tracks meet these
   * restrictions, AbrManager should not fail, but choose a low-res or
   * low-bandwidth variant instead.  It is the responsibility of AbrManager
   * implementations to follow these rules and implement this behavior.
   */
  restrictions: Restrictions;
  /**
   * The minimum amount of time that must pass between switches, in
   * seconds. This keeps us from changing too often and annoying the user.
   */
  switchInterval: number;
  /**
   * The fraction of the estimated bandwidth which we should try to use when
   * upgrading.
   */
  bandwidthUpgradeTarget: number;
  /**
   * The largest fraction of the estimated bandwidth we should use. We should
   * downgrade to avoid this.
   */
  bandwidthDowngradeTarget: number;
  /**
   * Advanced ABR configuration
   */
  advanced: AdvancedAbrConfiguration;
  /**
   * If true, restrict the quality to media element size.
   * Note: The use of ResizeObserver is required for it to work properly. If
   * true without ResizeObserver, it behaves as false.
   * Defaults false.
   */
  restrictToElementSize: boolean;
  /**
   *  If true, restrict the quality to screen size.
   *  Defaults false.
   */
  restrictToScreenSize: boolean;
  /**
   * If true,device pixel ratio is ignored when restricting the quality to
   * media element size or screen size.
   * Defaults false.
   */
  ignoreDevicePixelRatio: boolean;
  /**
   * If true, the buffer will be cleared during the switch.
   * The default automatic behavior is false to have a smoother transition.
   * On some device it's better to clear buffer.
   * Defaults false.
   */
  clearBufferSwitch: boolean;
  /**
   * Optional amount of buffer (in seconds) to
   * retain when clearing the buffer during the automatic switch.
   * Useful for switching variant quickly without causing a buffering event.
   * Defaults to 0 if not provided. Ignored if clearBuffer is false.
   * Can cause hiccups on some browsers if chosen too small, e.g.
   * The amount of two segments is a fair minimum to consider as safeMargin
   * value.
   */
  safeMarginSwitch: number;

  /**
   * Indicates the value in milliseconds from which a request is not
   * considered cached.
   * Defaults to <code>20</code>.
   */
  cacheLoadThreshold: number;
}

/**
 * @description
 *   Common Media Server Data (CMSD) configuration.
 */
export interface CmsdConfiguration {
  // If <code>true</code>, enables reading CMSD data in media requests.
  // Defaults to <code>true</code>.
  enabled: boolean;
  /**
   * If true, we must apply the maximum suggested bitrate. If false, we ignore
   * this.
   * Defaults to <code>true</code>.
   */
  applyMaximumSuggestedBitrate: boolean;
  /**
   * How much the estimatedThroughput of the CMSD data should be weighted
   * against the default estimate, between 0 and 1.
   * Defaults to <code>0.5</code>.
   */
  estimatedThroughputWeightRatio: number;
}

/**
 * @description
 *   Text displayer configuration.
 */
export interface TextDisplayerConfiguration {
  /**
   * The number of seconds to see if the captions should be updated.
   * Defaults to <code>0.25</code>.
   */
  captionsUpdatePeriod: number;
}

/**
 * @description
 * Ads configuration.
 */
export interface AdsConfiguration {
  /**
   * If this is <code>true</code>, we create a custom playhead tracker for
   * Client Side. This is useful because it allows you to implement the use of
   * IMA on platforms that do not support multiple video elements.
   * Defaults to <code>false</code> except on Tizen, WebOS, Chromecast,
   * Hisense, PlayStation 4, PlayStation5, Xbox whose default value is
   * <code>true</code>.
   */
  customPlayHeadTracker: boolean;
  /**
   * If this is true, we will load Client Side ads without waiting for a play
   * event.
   * Defaults to <code>false</code> except on Tizen, WebOS, Chromecast,
   * Hisense, PlayStation 4, PlayStation5, Xbox whose default value is
   * <code>true</code>.
   */
  skipPlayDetection: boolean;
  /**
   * If this is true, the browser supports multiple media elements.
   * Defaults to <code>true</code> except on Tizen, WebOS, Chromecast,
   * Hisense, PlayStation 4, PlayStation5, Xbox whose default value is
   * <code>false</code>.
   */
  supportsMultipleMediaElements: boolean;
}

/**
 *
 * @description
 * Contains information about the quality of an audio or video media stream.
 */
export interface MediaQualityInfo {
  /**
   * Specifies the maximum sampling rate of the content.
   */
  audioSamplingRate?: number;
  /**
   * The bandwidth in bits per second.
   */
  bandwidth: number;
  /**
   * The Stream's codecs, e.g., 'avc1.4d4015' or 'vp9', which must be
   * compatible with the Stream's MIME type.
   */
  codecs: string;
  /**
   * The type of content, which may be "video" or "audio".
   */
  contentType: string;
  /**
   * The video frame rate.
   */
  frameRate?: number;
  /**
   * The video height in pixels.
   */
  height?: number;
  /**
   * The video width in pixels.
   */
  width?: number;
  /**
   * The MIME type.
   */
  mimeType: string;
  /**
   * The number of audio channels, or null if unknown.
   */
  channelsCount?: number;
  /**
   * The pixel aspect ratio value; e.g. "1:1".
   */
  pixelAspectRatio?: string;
}

export interface PlayerConfiguration {
  /**
   * Ads configuration and settings.
   */
  ads: AdsConfiguration;

  /**
   * Controls behavior of auto-showing text tracks on load().
   */
  autoShowText: AutoShowText;
}

/**
 * Data structure for xml nodes as simple objects
 */
export interface XmlNode {
  tagName: string;
  attributes: Record<string, any>;
  children: (string | XmlNode)[];
  parent?: XmlNode | null;
}

/**
 *
 */
export interface DashManifestConfiguration {
  /**
   * A default clock sync URI to be used with live streams which do not
   * contain any clock sync information.  The <code>Date</code> header from this
   * URI will be used to determine the current time.
   */
  clockSyncUri: string;
  /**
   * If true will cause DASH parser to ignore DRM information specified
   * by the manifest and treat it as if it signaled no particular key
   * system and contained no init data. Defaults to false if not provided.
   */
  ignoreDrmInfo: boolean;
  /**
   * if true, xlink-related processing will be disabled. Defaults to
   * <code>false</code> if not provided.
   */
  disableXlinkProcessing: boolean;
  /**
   * If true, xlink-related errors will result in a fallback to the tag's
   * existing contents. If false, xlink-related errors will be propagated
   * to the application and will result in a playback failure. Defaults to
   * false if not provided.
   */
  xlinkFailGracefully: boolean;
  /**
   * If true will cause DASH parser to ignore <code>minBufferTime</code> from
   * manifest. It allows player config to take precedence over manifest for
   * <code>rebufferingGoal</code>. Defaults to <code>false</code> if not
   * provided.
   */
  ignoreMinBufferTime: boolean;
  /**
   * If <code>true</code>, ignore the <code>availabilityStartTime</code> in the
   * manifest and instead use the segments to determine the live edge.  This
   * allows us to play streams that have a lot of drift.  If <code>false</code>,
   * we can't play content where the manifest specifies segments in the future.
   * Defaults to <code>true</code>
   */
  autoCorrectDrift: boolean;
  /**
   * The maximum number of initial segments to generate for
   * <code>SegmentTemplate</code> with fixed-duration segments.  This is limited
   * to avoid excessive memory consumption with very large
   * <code>timeShiftBufferDepth</code> values.
   */
  initialSegmentLimit: number;
  /**
   * If true will cause DASH parser to ignore
   * <code>suggestedPresentationDelay</code> from manifest. Defaults to
   * <code>false</code> if not provided.
   */
  ignoreSuggestedPresentationDelay: boolean;

  /**
   * If true will cause DASH parser to ignore
   * empty <code>AdaptationSet</code> from manifest. Defaults to
   * <code>false</code> if not provided.
   */
  ignoreEmptyAdaptationSet: boolean;
  /**
   *  If true will cause DASH parser to ignore
   *  <code>maxSegmentDuration</code> from manifest. Defaults to
   *  <code>false</code> if not provided.
   */
  ignoreMaxSegmentDuration: boolean;
  /**
   * A map of scheme URI to key system name. Defaults to default key systems
   * mapping handled by Shaka.
   */
  keySystemsByURI: Record<string, string>;

  /**
   * <b>DEPRECATED</b>: Use manifestPreprocessorTXml instead.
   * Called immediately after the DASH manifest has been parsed into an
   * XMLDocument. Provides a way for applications to perform efficient
   * preprocessing of the manifest.
   * @deprecated
   */
  manifestPreprocessor: (ele: Element) => void;

  /**
   *
   * Called immediately after the DASH manifest has been parsed into an
   * XMLDocument. Provides a way for applications to perform efficient
   * preprocessing of the manifest.
   */
  manifestPreprocessorTXml: (node: XmlNode) => void;
  /**
   * If true, the media segments are appended to the SourceBuffer in
   * "sequence mode" (ignoring their internal timestamps).
   * <i>Defaults to <code>false</code>.</i>
   */
  sequenceMode: boolean;
  /**
   * If true, the media segments are appended to the SourceBuffer in
   * "sequence mode" (ignoring their internal timestamps).
   * <i>Defaults to <code>false</code>.</i>
   */
  enableAudioGroups: boolean;

  /**
   * If true, the manifest parser will create variants that have multiple
   * mimeTypes or codecs for video or for audio if there is no other choice.
   * Meant for content where some periods are only available in one mimeType or
   * codec, and other periods are only available in a different mimeType or
   * codec. For example, a stream with baked-in ads where the audio codec does
   * not match the main content.
   * Might result in undesirable behavior if mediaSource.codecSwitchingStrategy
   * is not set to SMOOTH.
   * Defaults to true if SMOOTH codec switching is supported, RELOAD overwise.
   */
  multiTypeVariantsAllowed: boolean;

  /**
   *  If period combiner is used, this option ensures every stream is used
   *  only once in period flattening. It speeds up underlying algorithm
   *  but may raise issues if manifest does not have stream consistency
   *  between periods.
   *  Defaults to <code>false</code>.
   */
  useStreamOnceInPeriodFlattening: boolean;
  /**
   * Override the minimumUpdatePeriod of the manifest. The value is in second
   * if the value is greater than the minimumUpdatePeriod, it will update the
   * manifest less frequently. if you update the value during for a dynamic
   * manifest, it will directly trigger a new download of the manifest
   * Defaults to <code>-1</code>.
   */
  updatePeriod: number;
  /**
   * If false, disables fast switching track recognition.
   * Defaults to <code>true</code>.
   */
  enableFastSwitching: boolean;
}

export interface HlsManifestConfiguration {
  /**
   * If <code>true</code>, ignore any errors in a text stream and filter out
   * those streams.
   */
  ignoreTextStreamFailures: boolean;
  /**
   * If <code>true</code>, ignore any errors in a image stream and filter out
   * those streams.
   */
  ignoreImageStreamFailures: boolean;
  /**
   * The default audio codec if it is not specified in the HLS playlist.
   * <i>Defaults to <code>'mp4a.40.2'</code>.</i>
   */
  defaultAudioCodec: string;
  /**
   * The default video codec if it is not specified in the HLS playlist.
   * <i>Defaults to <code>'avc1.42E01E'</code>.</i>
   */
  defaultVideoCodec: string;
  /**
   * If <code>true</code>, the HLS parser will ignore the
   * <code>EXT-X-PROGRAM-DATE-TIME</code> tags in the manifest and use media
   * sequence numbers instead. It also causes EXT-X-DATERANGE tags to be
   * ignored.  Meant for streams where <code>EXT-X-PROGRAM-DATE-TIME</code> is
   * incorrect or malformed.
   * <i>Defaults to <code>false</code>.</i>
   */
  ignoreManifestProgramDateTime: boolean;
  /**
   * An array of strings representing types for which
   * <code>EXT-X-PROGRAM-DATE-TIME</code> should be ignored. Only used if the
   * the main ignoreManifestProgramDateTime is set to false.
   * For example, setting this to ['text', 'video'] will cause the PDT values
   * text and video streams to be ignored, while still using the PDT values for
   * audio.
   * <i>Defaults to an empty array.</i>
   */
  ignoreManifestProgramDateTimeForTypes: string[];
  /**
   * A string containing a full mime type, including both the basic mime type
   * and also the codecs. Used when the HLS parser parses a media playlist
   * directly, required since all of the mime type and codecs information is
   * contained within the master playlist.
   * You can use the <code>shaka.util.MimeUtils.getFullType()</code> utility to
   * format this value.
   * <i>Defaults to
   * <code>'video/mp2t; codecs="avc1.42E01E, mp4a.40.2"'</code>.</i>
   */
  mediaPlaylistFullMimeType: string;
  /**
   * If this is true, playback will set the availability window to the
   * presentation delay. The player will be able to buffer ahead three
   * segments, but the seek window will be zero-sized, to be consistent with
   * Safari. If this is false, the seek window will be the entire duration.
   * <i>Defaults to <code>true</code>.</i>
   */
  useSafariBehaviorForLive: boolean;
  /**
   * The default presentation delay will be calculated as a number of segments.
   * This is the number of segments for this calculation..
   * <i>Defaults to <code>3</code>.</i>
   */
  liveSegmentsDelay: number;

  /**
   * If true, the media segments are appended to the SourceBuffer in
   * "sequence mode" (ignoring their internal timestamps).
   * Defaults to <code>true</code> except on WebOS 3, Tizen 2,
   * Tizen 3 and PlayStation 4 whose default value is <code>false</code>.
   */
  sequenceMode: boolean;
  /**
   * If true, don't adjust the timestamp offset to account for manifest
   * segment durations being out of sync with segment durations. In other
   * words, assume that there are no gaps in the segments when appending
   * to the SourceBuffer, even if the manifest and segment times disagree.
   * Only applies when sequenceMode is <code>false</code>.
   * <i>Defaults to <code>false</code>.</i>
   */
  ignoreManifestTimestampsInSegmentsMode: boolean;
  /**
   * If set to true, the HLS parser won't automatically guess or assume default
   * codec for playlists with no "CODECS" attribute. Instead, it will attempt to
   * extract the missing information from the media segment.
   * As a consequence, lazy-loading media playlists won't be possible for this
   * use case, which may result in longer video startup times.
   * <i>Defaults to <code>false</code>.</i>
   */
  disableCodecGuessing: boolean;

  /**
   * If true, disables the automatic detection of closed captions.
   * Otherwise, in the absence of a EXT-X-MEDIA tag with TYPE="CLOSED-CAPTIONS",
   * Shaka Player will attempt to detect captions based on the media data.
   * <i>Defaults to <code>false</code>.</i>
   */
  disableClosedCaptionsDetection: boolean;

  /**
   * If set to true, the HLS parser will optimize operation with LL and partial
   * byte range segments. More info in
   * https://www.akamai.com/blog/performance/-using-ll-hls-with-byte-range-addressing-to-achieve-interoperabi
   * <i>Defaults to <code>true</code>.</i>
   */
  allowLowLatencyByteRangeOptimization: boolean;
}

export interface MssManifestConfiguration {
  /**
   * <b>DEPRECATED</b>: Use manifestPreprocessorTXml instead.
   * Called immediately after the MSS manifest has been parsed into an
   * XMLDocument. Provides a way for applications to perform efficient
   * preprocessing of the manifest.
   * @deprecated
   */
  manifestPreprocessor(ele: Element): void;
  /**
   * Called immediately after the MSS manifest has been parsed into an
   * XMLDocument. Provides a way for applications to perform efficient
   * preprocessing of the manifest.
   */
  manifestPreprocessorTXml(node: XmlNode): void;
  /**
   * If true, the media segments are appended to the SourceBuffer in
   * "sequence mode" (ignoring their internal timestamps).
   * <i>Defaults to <code>false</code>.</i>
   */
  sequenceMode: boolean;
  /**
   * A map of system id to key system name. Defaults to default key systems
   * mapping handled by Shaka.
   */
  keySystemsBySystemId: Record<string, string>;
}

export interface ManifestConfiguration {
  // Retry parameters for manifest requests.
  retryParameters: RetryParameters;
  /**
   * A number, in seconds, that overrides the availability window in the
   * manifest, or <code>NaN</code> if the default value should be used.  This is
   * enforced by the manifest parser, so custom manifest parsers should take
   * care to honor this parameter.
   */
  availabilityWindowOverride: number;
  /**
   * If <code>true</code>, the audio tracks are ignored.
   * Defaults to <code>false</code>.
   */
  disableAudio: boolean;
  /**
   * If <code>true</code>, the video tracks are ignored.
   * Defaults to <code>false</code>.
   */
  disableVideo: boolean;
  /**
   * If <code>true</code>, the text tracks are ignored.
   * Defaults to <code>false</code>.
   */
  disableText: boolean;
  /**
   * If <code>true</code>, the image tracks are ignored.
   * Defaults to <code>false</code>.
   */
  disableThumbnails: boolean;
  /**
   * A default <code>presentationDelay</code> value.
   * For DASH, it's a default <code>presentationDelay</code> value if
   * <code>suggestedPresentationDelay</code> is missing in the MPEG DASH
   * manifest. The default value is <code>1.5 * minBufferTime</code> if not
   * configured or set as 0.
   * For HLS, the default value is 3 segments duration if not configured or
   * set as 0.
   */
  defaultPresentationDelay: number;
  /**
   *  Option to calculate VTT text timings relative to the segment start
   *  instead of relative to the period start (which is the default).
   *  Defaults to <code>false</code>.
   */
  segmentRelativeVttTiming: boolean;
  // Advanced parameters used by the DASH manifest parser.
  dash: DashManifestConfiguration;
  // Advanced parameters used by the HLS manifest parser.
  hls: HlsManifestConfiguration;
  // Advanced parameters used by the MSS manifest parser.
  mss: MssManifestConfiguration;
  /**
   * If true, manifest update request failures will cause a fatal error.
   * Defaults to <code>false</code> if not provided.
   */
  raiseFatalErrorOnManifestUpdateRequestFailure: boolean;
}

/**
 * @description
 * Contains information about a region of the timeline that will cause an event
 * to be raised when the playhead enters or exits it.  In DASH this is the
 * EventStream element.
 */
export interface TimelineRegionInfo {
  //  Identifies the message scheme.
  schemeIdUri: string;
  // Specifies the value for the region.
  value: string;
  // The presentation time (in seconds) that the region should start.
  startTime: number;
  // The presentation time (in seconds) that the region should end.
  endTime: number;
  // Specifies an identifier for this instance of the region.
  id: string;
  /**
   * <b>DEPRECATED</b>: Use eventElement instead.
   * The XML element that defines the Event.
   * @deprecated
   */
  eventElement: Element;
  // The XML element that defines the Event.
  eventNode: XmlNode;
}

/**
 *  metadata frame parsed.
 */
export interface MetadataFrame {
  key: string;
  data: ArrayBuffer | string | number;
  description: string;
  mimeType?: string;
  pictureType?: number;
}
