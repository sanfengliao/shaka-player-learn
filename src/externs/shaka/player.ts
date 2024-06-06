import { AutoShowText } from '../../lib/config/auto_show_text';

/**
 * @typedef {{
 *   minTotalBytes: number,
 *   minBytes: number,
 *   fastHalfLife: number,
 *   slowHalfLife: number
 * }}
 *
 * @property {number} minTotalBytes
 *   Minimum number of bytes sampled before we trust the estimate.  If we have
 *   not sampled much data, our estimate may not be accurate enough to trust.
 * @property {number} minBytes
 *   Minimum number of bytes, under which samples are discarded.  Our models
 *   do not include latency information, so connection startup time (time to
 *   first byte) is considered part of the download time.  Because of this, we
 *   should ignore very small downloads which would cause our estimate to be
 *   too low.
 * @property {number} fastHalfLife
 *   The quantity of prior samples (by weight) used when creating a new
 *   estimate, in seconds.  Those prior samples make up half of the
 *   new estimate.
 * @property {number} slowHalfLife
 *   The quantity of prior samples (by weight) used when creating a new
 *   estimate, in seconds.  Those prior samples make up half of the
 *   new estimate.
 * @exportDoc
 */
export interface AdvancedAbrConfiguration {
  /**
   * Minimum number of bytes sampled before we trust the estimate.  If we have
   * not sampled much data, our estimate may not be accurate enough to trust.
   */
  minTotalBytes: number;
  minBytes: number;
  fastHalfLife: number;
  slowHalfLife: number;
}

/**
 * @typedef {{
 *   minWidth: number,
 *   maxWidth: number,
 *   minHeight: number,
 *   maxHeight: number,
 *   minPixels: number,
 *   maxPixels: number,
 *
 *   minFrameRate: number,
 *   maxFrameRate: number,
 *
 *   minBandwidth: number,
 *   maxBandwidth: number
 * }}
 *
 * @description
 * An object describing application restrictions on what tracks can play.  All
 * restrictions must be fulfilled for a track to be playable/selectable.
 * The restrictions system behaves somewhat differently at the ABR level and the
 * player level, so please refer to the documentation for those specific
 * settings.
 *
 * @see shaka.extern.PlayerConfiguration
 * @see shaka.extern.AbrConfiguration
 *
 * @property {number} minWidth
 *   The minimum width of a video track, in pixels.
 * @property {number} maxWidth
 *   The maximum width of a video track, in pixels.
 * @property {number} minHeight
 *   The minimum height of a video track, in pixels.
 * @property {number} maxHeight
 *   The maximum height of a video track, in pixels.
 * @property {number} minPixels
 *   The minimum number of total pixels in a video track (i.e.
 *   <code>width * height</code>).
 * @property {number} maxPixels
 *   The maximum number of total pixels in a video track (i.e.
 *   <code>width * height</code>).
 *
 * @property {number} minFrameRate
 *   The minimum framerate of a variant track.
 * @property {number} maxFrameRate
 *   The maximum framerate of a variant track.
 *
 * @property {number} minBandwidth
 *   The minimum bandwidth of a variant track, in bit/sec.
 * @property {number} maxBandwidth
 *   The maximum bandwidth of a variant track, in bit/sec.
 * @exportDoc
 */
export interface Restrictions {
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
  minPixels: number;
  maxPixels: number;
  minFrameRate: number;
  maxFrameRate: number;
  minBandwidth: number;
  maxBandwidth: number;
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
  enabled: boolean;
  useNetworkInformation: boolean;
  defaultBandwidthEstimate: number;
  restrictions: Restrictions;
  switchInterval: number;
  bandwidthUpgradeTarget: number;
  bandwidthDowngradeTarget: number;
  advanced: AdvancedAbrConfiguration;
  restrictToElementSize: boolean;
  restrictToScreenSize: boolean;
  ignoreDevicePixelRatio: boolean;
  clearBufferSwitch: boolean;
  safeMarginSwitch: number;
}

/**
 * @typedef {{
 *   enabled: boolean,
 *   applyMaximumSuggestedBitrate: boolean,
 *   estimatedThroughputWeightRatio: number
 * }}
 *
 * @description
 *   Common Media Server Data (CMSD) configuration.
 *
 * @property {boolean} enabled
 *   If <code>true</code>, enables reading CMSD data in media requests.
 *   Defaults to <code>true</code>.
 * @property {boolean} applyMaximumSuggestedBitrate
 *   If true, we must apply the maximum suggested bitrate. If false, we ignore
 *   this.
 *   Defaults to <code>true</code>.
 * @property {number} estimatedThroughputWeightRatio
 *   How much the estimatedThroughput of the CMSD data should be weighted
 *   against the default estimate, between 0 and 1.
 *   Defaults to <code>0.5</code>.
 * @exportDoc
 */
export interface CmsdConfiguration {
  enabled: boolean;
  applyMaximumSuggestedBitrate: boolean;
  estimatedThroughputWeightRatio: number;
}

/**
 * @typedef {{
 *   captionsUpdatePeriod: number
 * }}
 *
 * @description
 *   Text displayer configuration.
 *
 * @property {number} captionsUpdatePeriod
 *   The number of seconds to see if the captions should be updated.
 *   Defaults to <code>0.25</code>.
 *
 * @exportDoc
 */
export interface TextDisplayerConfiguration {
  captionsUpdatePeriod: number;
}

/**
 * @typedef {{
 *   customPlayheadTracker: boolean,
 *   skipPlayDetection: boolean,
 *   supportsMultipleMediaElements: boolean
 * }}
 *
 * @description
 *   Ads configuration.
 *
 * @property {boolean} customPlayheadTracker
 *   If this is <code>true</code>, we create a custom playhead tracker for
 *   Client Side. This is useful because it allows you to implement the use of
 *   IMA on platforms that do not support multiple video elements.
 *   Defaults to <code>false</code> except on Tizen, WebOS, Chromecast,
 *   Hisense, PlayStation 4, PlayStation5, Xbox whose default value is
 *   <code>true</code>.
 * @property {boolean} skipPlayDetection
 *   If this is true, we will load Client Side ads without waiting for a play
 *   event.
 *   Defaults to <code>false</code> except on Tizen, WebOS, Chromecast,
 *   Hisense, PlayStation 4, PlayStation5, Xbox whose default value is
 *   <code>true</code>.
 * @property {boolean} supportsMultipleMediaElements
 *   If this is true, the browser supports multiple media elements.
 *   Defaults to <code>true</code> except on Tizen, WebOS, Chromecast,
 *   Hisense, PlayStation 4, PlayStation5, Xbox whose default value is
 *   <code>false</code>.
 *
 * @exportDoc
 */
export interface AdsConfiguration {
  customPlayHeadTracker: boolean;
  skipPlayDetection: boolean;
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
