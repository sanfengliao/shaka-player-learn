import { AutoShowText } from '../../lib/config/auto_show_text';
import { CodecSwitchingStrategy } from '../../lib/config/codec_switching_strategy';
import { AccessibilityPurpose } from '../../lib/media/manifest_parser';
import { ShakaError } from '../../lib/util/error';
import { AbrManagerFactory } from './abr_manager';
import { DrmInfo } from './manifest';
import { RetryParameters } from './net';
import { ModifyCueCallback, TextDisplayerFactory } from './text';

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
  customPlayheadTracker: boolean;
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
  audioSamplingRate: number | null;
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
  frameRate?: number | null;
  /**
   * The video height in pixels.
   */
  height?: number | null;
  /**
   * The video width in pixels.
   */
  width?: number | null;
  /**
   * The MIME type.
   */
  mimeType: string;
  /**
   * The number of audio channels, or null if unknown.
   */
  channelsCount: number | null;
  /**
   * The pixel aspect ratio value; e.g. "1:1".
   */
  pixelAspectRatio?: string | null;
}

/**
 * DRM Session Metadata for saved persistent session
 */
export interface PersistentSessionMetadata {
  // Session id
  sessionId: string;
  // Initialization data in the format indicated by initDataType.
  initData: Uint8Array | null;
  // A string to indicate what format initData is in.
  initDataType: string | null;
}

export interface AdvancedDrmConfiguration {
  /**
   * <i>Defaults to false.</i> <br>
   *   True if the application requires the key system to support distinctive
   *   identifiers.
   */
  distinctiveIdentifierRequired: boolean;
  /**
   *  <i>Defaults to false.</i> <br>
   *   True if the application requires the key system to support persistent
   *   state, e.g., for persistent license storage.
   */
  persistentStateRequired: boolean;
  /**
   *  A key-system-specific string that specifies a required security level for
   *   video.
   *   <i>Defaults to <code>''</code>, i.e., no specific robustness required.</i>
   */
  videoRobustness: string;
  /**
   * A key-system-specific string that specifies a required security level for
   *   audio.
   *   <i>Defaults to <code>''</code>, i.e., no specific robustness required.</i>
   */
  audioRobustness: string;
  /**
   * <i>Defaults to null.</i> <br>
   *   <i>An empty certificate (<code>byteLength==0</code>) will be treated as
   *   <code>null</code>.</i> <br>
   *   <i>A certificate will be requested from the license server if
   *   required.</i> <br>
   *   A key-system-specific server certificate used to encrypt license requests.
   *   Its use is optional and is meant as an optimization to avoid a round-trip
   *   to request a certificate.
   */
  serverCertificate: Uint8Array;
  /**
   * <i>Defaults to <code>''</code>.</i><br>
   *   If given, will make a request to the given URI to get the server
   *   certificate. This is ignored if <code>serverCertificate</code> is set.
   */
  serverCertificateUri: string;
  /**
   *  The server that handles an <code>'individualiation-request'</code>.  If the
   *   server isn't given, it will default to the license server.
   */
  individualizationServer: string;
  /**
   * <i>Defaults to <code>'temporary'</code> for streaming.</i> <br>
   *   The MediaKey session type to create streaming licenses with.  This doesn't
   *   affect offline storage.
   */
  sessionType: string;
  /**
   * The headers to use in the license request.
   */
  headers: Record<string, string>;
}

/**
 *  A callback function to handle custom content ID signaling for FairPlay
 * content.
 */
type InitDataTransform = (a: Uint8Array, b: string, c: DrmInfo) => Uint8Array;

// TODO(sanfeng): DRM功能
export interface DrmConfiguration {
  //  Retry parameters for license requests.
  retryParameters: RetryParameters;
  /**
   * <i>Required for all but the clear key CDM.</i> <br>
   *   A dictionary which maps key system IDs to their license servers.
   *   For example,
   *   <code>{'com.widevine.alpha': 'https://example.com/drm'}</code>.
   */
  servers: Record<string, string>;
  /**
   * <i>Forces the use of the Clear Key CDM.</i>
   *   A map of key IDs (hex or base64) to keys (hex or base64).
   */
  clearKeys: Record<string, string>;
  /**
   * <i>Defaults to false.</i> <br>
   *   True to configure drm to delay sending a license request until a user
   *   actually starts playing content.
   */
  delayLicenseRequestUntilPlayed: boolean;
  /**
   *  <i>Defaults to false.</i> <br>
   *   True to configure drm to try playback with given persistent session ids
   *   before requesting a license. Also prevents the session removal at playback
   *   stop, as-to be able to re-use it later.
   */
  persistentSessionOnlinePlayback: boolean;
  /**
   * Persistent sessions metadata to load before starting playback
   */
  persistentSessionsMetadata: PersistentSessionMetadata[];
  /**
   * <i>Optional.</i> <br>
   *   A dictionary which maps key system IDs to advanced DRM configuration for
   *   those key systems.
   */
  advanced: Record<string, AdvancedDrmConfiguration>;
  /**
   *  <i>Optional.</i><br>
   *   If given, this function is called with the init data from the
   *   manifest/media and should return the (possibly transformed) init data to
   *   pass to the browser.
   */
  initDataTransform: InitDataTransform | undefined;
  /**
   * <i>Optional.</i><br>
   *   If set to <code>true</code>, prints logs containing the license exchange.
   *   This includes the init data, request, and response data, printed as base64
   *   strings.  Don't use in production, for debugging only; has no affect in
   *   release builds as logging is removed.
   */
  logLicenseExchange: boolean;
  /**
   * <i>Defaults to 1.</i> <br>
   *   The frequency in seconds with which to check the expiration of a session.
   */
  updateExpirationTime: number;
  /**
   * <i>Defaults ['com.microsoft.playready'] on Xbox One and PlayStation 4, and
   *   an empty array for all other browsers.</i> <br>
   *   Specifies the priorties of available DRM key systems.
   */
  preferredKeySystems: string[];
  //  A map of key system name to key system name.
  keySystemsMapping: Record<string, string>;
  /**
   * <i>Defaults to true on Xbox One, and false for all other browsers.</i><br>
   *   When true parse DRM init data from pssh boxes in media and init segments
   *   and ignore 'encrypted' events.
   *   This is required when using in-band key rotation on Xbox One.
   */
  parseInbandPsshEnabled: boolean;
  /**
   * <i>By default (''), do not check the HDCP version.</i><br>
   *   Indicates the minimum version of HDCP to start the playback of encrypted
   *   streams. <b>May be ignored if not supported by the device.</b>
   */
  minHdcpVersion: string;
  /**
   * <i>Defaults to false on Tizen 2, and true for all other browsers.</i><br>
   *   When true indicate that the player doesn't ignore duplicate init data.
   *   Note: Tizen 2015 and 2016 models will send multiple webkitneedkey events
   *   with the same init data. If the duplicates are supressed, playback
   *   will stall without errors.
   */
  ignoreDuplicateInitData: boolean;
}

/**
 * The StreamingEngine's configuration options.
 */
export interface StreamingConfiguration {
  // Retry parameters for segment requests.
  retryParameters: RetryParameters;
  /**
   * A callback to decide what to do on a streaming failure.  Default behavior
   * is to retry on live streams and not on VOD.
   */
  failureCallback: (error: ShakaError) => void;
  /**
   * The minimum number of seconds of content that the StreamingEngine must
   * buffer before it can begin playback or can continue playback after it has
   * entered into a buffering state (i.e., after it has depleted one more
   * more of its buffers).
   */
  rebufferingGoal: number;
  /**
   * The number of seconds of content that the StreamingEngine will attempt to
   * buffer ahead of the playhead. This value must be greater than or equal to
   * the rebuffering goal.
   */
  bufferingGoal: number;
  /**
   * The maximum number of seconds of content that the StreamingEngine will keep
   * in buffer behind the playhead when it appends a new media segment.
   * The StreamingEngine will evict content to meet this limit.
   */
  bufferBehind: number;
  /**
   * The minimum duration in seconds of buffer overflow the StreamingEngine
   * requires to start removing content from the buffer.
   * Values less than <code>1.0</code> are not recommended.
   */
  evictionGoal: number;
  /**
   * If <code>true</code>, the player will ignore text stream failures and
   * continue playing other streams.
   */
  ignoreTextStreamFailures: boolean;
  /**
   * If <code>true</code>, always stream text tracks, regardless of whether or
   * not they are shown.  This is necessary when using the browser's built-in
   * controls, which are not capable of signaling display state changes back to
   * Shaka Player.
   * Defaults to <code>false</code>.
   */
  alwaysStreamText: boolean;
  /**
   * If <code>true</code>, adjust the start time backwards so it is at the start
   * of a segment. This affects both explicit start times and calculated start
   * time for live streams. This can put us further from the live edge. Defaults
   * to <code>false</code>.
   */
  startAtSegmentBoundary: boolean;

  /**
   * The maximum distance (in seconds) before a gap when we'll automatically
   * ump. This value defaults to <code>0.5</code>.
   */
  gapDetectionThreshold: number;
  /**
   * The polling time in seconds to check for gaps in the media. This value
   * defaults to <code>0.25</code>.
   */
  gapJumpTimerTime: number;

  /**
   * By default, we will not allow seeking to exactly the duration of a
   * presentation.  This field is the number of seconds before duration we will
   * seek to when the user tries to seek to or start playback at the duration.
   * To disable this behavior, the config can be set to 0.  We recommend using
   * the default value unless you have a good reason not to.
   */
  durationBackoff: number;
  /**
   * The amount of seconds that should be added when repositioning the playhead
   * after falling out of the availability window or seek. This gives the player
   * more time to buffer before falling outside again, but increases the forward
   * jump in the stream skipping more content. This is helpful for lower
   * bandwidth scenarios. Defaults to 5 if not provided.
   */
  safeSeekOffset: number;
  /**
   * When set to <code>true</code>, the stall detector logic will run.  If the
   * playhead stops moving for <code>stallThreshold</code> seconds, the player
   * will either seek or pause/play to resolve the stall, depending on the value
   * of <code>stallSkip</code>.
   */
  stallEnabled: boolean;
  /**
   * The maximum number of seconds that may elapse without the playhead moving
   * (when playback is expected) before it will be labeled as a stall.
   */
  stallThreshold: number;
  /**
   * The number of seconds that the player will skip forward when a stall has
   * been detected.  If 0, the player will pause and immediately play instead of
   * seeking.  A value of 0 is recommended and provided as default on TV
   * platforms (WebOS, Tizen, Chromecast, etc).
   */
  stallSkip: number;
  /**
   * Desktop Safari has both MediaSource and their native HLS implementation.
   * Depending on the application's needs, it may prefer one over the other.
   * Only applies to clear streams
   * Defaults to <code>true</code>.
   */
  useNativeHlsOnSafari: boolean;
  /**
   * Desktop Safari has both MediaSource and their native HLS implementation.
   * Depending on the application's needs, it may prefer one over the other.
   * Warning when disabled: Where single-key DRM streams work fine, multi-keys
   * streams is showing unexpected behaviours (stall, audio playing with video
   * freezes, ...). Use with care.
   * Defaults to <code>true</code>.
   */
  useNativeHlsForFairPlay: boolean;
  /**
   * The maximum difference, in seconds, between the times in the manifest and
   * the times in the segments.  Larger values allow us to compensate for more
   * drift (up to one segment duration).  Smaller values reduce the incidence of
   * extra segment requests necessary to compensate for drift.
   */
  inaccurateManifestTolerance: number;

  /**
   * If <code>true</code>, low latency streaming mode is enabled. If
   * lowLatencyMode is set to true, it changes the default config values for
   * other things, see: docs/tutorials/config.md
   */
  lowLatencyMode: boolean;
  /**
   * If the stream is low latency and the user has not configured the
   * lowLatencyMode, but if it has been configured to activate the
   * lowLatencyMode if a stream of this type is detected, we automatically
   * activate the lowLatencyMode. Defaults to false.
   */
  autoLowLatencyMode: boolean;

  forceHTTP: boolean;
  forceHTTPS: boolean;
  /**
   * If true, prefer native HLS playback when possible, regardless of platform.
   */
  preferNativeHls: boolean;
  /**
   * The minimum number of seconds to see if the manifest has changes.
   */
  updateIntervalSeconds: number;
  /**
   *  If true, all emsg boxes are parsed and dispatched.
   */
  dispatchAllEmsgBoxes: boolean;
  /**
   * If true, monitor media quality changes and emit
   *  <code>shaka.Player.MediaQualityChangedEvent</code>.
   */
  observeQualityChanges: boolean;
  /**
   * The maximum time a variant can be disabled when NETWORK HTTP_ERROR
   *  is reached, in seconds.
   *  If all variants are disabled this way, NETWORK HTTP_ERROR will be thrown.
   */
  maxDisabledTime: number;
  /**
   * If <code>true</code>, will raise a shaka.extern.ProducerReferenceTime
   * player event (event name 'prft').
   * The event will be raised only once per playback session as program
   * start date will not change, and would save parsing the segment multiple
   * times needlessly.
   * Defaults to <code>false</code>.
   */
  parsePrftBox: boolean;
  /**
   * The maximum number of segments for each active stream to be prefetched
   * ahead of playhead in parallel.
   * If <code>0</code>, the segments will be fetched sequentially.
   * Defaults to <code>0</code>.
   */
  segmentPrefetchLimit: number;
  /**
   *  The audio languages to prefetch.
   *  Defaults to an empty array.
   */
  prefetchAudioLanguages: string[];
  /**
   * If set and prefetch limit is defined, it will prevent from prefetching data
   *  for audio.
   *  Defaults to <code>false</code>.
   */
  disableAudioPrefetch: boolean;
  /**
   * If set and prefetch limit is defined, it will prevent from prefetching data
   * for text.
   * Defaults to <code>false</code>.
   */
  disableTextPrefetch: boolean;
  /**
   * If set and prefetch limit is defined, it will prevent from prefetching data
   * for video.
   * Defaults to <code>false</code>.
   */
  disableVideoPrefetch: boolean;
  /**
   * Enable the live stream sync against the live edge by changing the playback
   * rate. Defaults to <code>false</code>.
   * Note: on some SmartTVs, if this is activated, it may not work or the sound
   * may be lost when activated.
   */
  liveSync: boolean;
  /**
   * Latency tolerance for target latency, in seconds. Effective only if
   * liveSync is true. Defaults to <code>0.5</code>.
   */
  liveSyncTargetLatencyTolerance: number;
  /**
   * Maximum acceptable latency, in seconds. Effective only if liveSync is
   * true. Defaults to <code>1</code>.
   */
  liveSyncMaxLatency: number;

  /**
   * Playback rate used for latency chasing. It is recommended to use a value
   * between 1 and 2. Effective only if liveSync is true. Defaults to
   * <code>1.1</code>.
   */
  liveSyncPlaybackRate: number;
  /**
   * Minimum acceptable latency, in seconds. Effective only if liveSync is
   * true. Defaults to <code>0</code>.
   */
  liveSyncMinLatency: number;
  /**
   * Minimum playback rate used for latency chasing. It is recommended to use a
   * value between 0 and 1. Effective only if liveSync is true. Defaults to
   * <code>0.95</code>.
   */
  liveSyncMinPlaybackRate: number;
  /**
   * If <code>true</code>, panic mode for live sync is enabled. When enabled,
   * will set the playback rate to the <code>liveSyncMinPlaybackRate</code>
   * until playback has continued past a rebuffering for longer than the
   * <code>liveSyncPanicThreshold</code>. Defaults to <code>false</code>.
   */
  liveSyncPanicMode: boolean;
  /**
   * Number of seconds that playback stays in panic mode after a rebuffering.
   * Defaults to <code>60</code>
   */
  liveSyncPanicThreshold: number;
  /**
   * Indicate if we should recover from VIDEO_ERROR resetting Media Source.
   * Defaults to <code>true</code>.
   */
  allowMediaSourceRecoveries: boolean;
  /**
   * The minimum time between recoveries when VIDEO_ERROR is reached, in
   * seconds.
   * Defaults to <code>5</code>.
   */
  minTimeBetweenRecoveries: number;
  /**
   *  Adapt the playback rate of the player to keep the buffer full. Defaults to
   *   <code>false</code>.
   */
  vodDynamicPlaybackRate: boolean;
  /**
   * Playback rate to use if the buffer is too small. Defaults to
   * <code>0.95</code>.
   */

  vodDynamicPlaybackRateLowBufferRate: number;
  /**
   * Ratio of the <code>bufferingGoal</code> as the low threshold for
   *   setting the playback rate to
   *   <code>vodDynamicPlaybackRateLowBufferRate</code>.
   *   Defaults to <code>0.5</code>.
   */
  vodDynamicPlaybackRateBufferRatio: number;
  /**
   * If <code>true</code>, the media source live duration
   * set as a<code>Infinity</code>
   * Defaults to <code> false </code>.
   */
  infiniteLiveStreamDuration: boolean;
  /**
   * The window of time at the end of the presentation to begin preloading the
   * next URL, such as one specified by a urn:mpeg:dash:chaining:2016 element
   * in DASH. Measured in seconds. If the value is 0, the next URL will not
   * be preloaded at all.
   * Defaults to <code> 30 </code>.
   */
  preloadNextUrlWindow: number;

  /**
   * The maximum timeout to reject the load when using src= in case the content
   * does not work correctly.  Measured in seconds.
   * Defaults to <code> 30 </code>.
   */
  loadTimeout: number;
  /**
   * Clears decodingInfo and MediaKeySystemAccess cache during player unload
   * as these objects may become corrupt and cause issues during subsequent
   * playbacks on some platforms.
   * Defaults to <code>true</code> on PlayStation devices and to
   * <code>false</code> on other devices.
   */
  clearDecodingCache: boolean;
  /**
   * If true, we don't choose codecs in the player, and keep all the variants.
   * Defaults to <code>false</code>.
   */
  dontChooseCodecs: boolean;
}

/**
 * Media source configuration.
 */
export interface MediaSourceConfiguration {
  /**
   * Allow codec switching strategy. SMOOTH loading uses
   * SourceBuffer.changeType. RELOAD uses cycling of MediaSource.
   * Defaults to SMOOTH if SMOOTH codec switching is supported, RELOAD
   * overwise.
   */
  codecSwitchingStrategy: CodecSwitchingStrategy;
  /**
   *
   * Callback to generate extra features string based on used MIME type.
   * Some platforms may need to pass features when initializing the
   * sourceBuffer.
   * This string is ultimately appended to a MIME type in addSourceBuffer() &
   * changeType().
   */
  addExtraFeaturesToSourceBuffer: (feature: string) => string;
  /**
   * If this is <code>true</code>, we will transmux AAC and TS content even if
   * not strictly necessary for the assets to be played.
   * This value defaults to <code>false</code>.
   */
  forceTransmux: boolean;
  /**
   * If true, will apply a work-around for non-encrypted init segments on
   * encrypted content for some platforms.
   * <br><br>
   * See https://github.com/shaka-project/shaka-player/issues/2759.
   * <br><br>
   * If you know you don't need this, you canset this value to
   * <code>false</code> to gain a few milliseconds on loading time and seek
   * time.
   * <br><br>
   * This value defaults to <code>true</code>.
   */
  insertFakeEncryptionInInit: boolean;
  /**
   * A callback called for each cue after it is parsed, but right before it
   * is appended to the presentation.
   * Gives a chance for client-side editing of cue text, cue timing, etc.
   */
  modifyCueCallback: ModifyCueCallback;
}

/**
 * Common Media Client Data (CMCD) configuration.
 */
export interface CmcdConfiguration {
  /**
   * If <code>true</code>, enable CMCD data to be sent with media requests.
   * Defaults to <code>false</code>.
   */
  enabled: boolean;
  /**
   * If <code>true</code>, send CMCD data using the header transmission mode
   * instead of query args.  Defaults to <code>false</code>.
   */
  useHeaders: boolean;
  /**
   * A GUID identifying the current playback session. A playback session
   * typically ties together segments belonging to a single media asset.
   * Maximum length is 64 characters. It is RECOMMENDED to conform to the UUID
   * specification. By default the sessionId is automatically generated on each
   * <code>load()</code> call.
   */
  sessionId: string;
  /**
   * A unique string identifying the current content. Maximum length is 64
   * characters. This value is consistent across multiple different sessions and
   * devices and is defined and updated at the discretion of the service
   * provider.
   */
  contentId: string;
  /**
   * RTP safety factor.
   * Defaults to <code>5</code>.
   */
  rtpSafetyFactor: number;
  /**
   * An array of keys to include in the CMCD data. If not provided, all keys
   * will be included.
   */
  includeKeys: string[];
}

/**
 * Common Media Server Data (CMSD) configuration.
 */
export interface CmsdConfiguration {
  /**
   *  If <code>true</code>, enables reading CMSD data in media requests.
   *  Defaults to <code>true</code>.
   */
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
 *  Decoding for MPEG-5 Part2 LCEVC.
 */
export interface LcevcConfiguration {
  /**
   * If <code>true</code>, enable LCEVC.
   * Defaults to <code>false</code>.
   */
  enabled: boolean;
  /**
   * If <code>true</code>, LCEVC Dynamic Performance Scaling or dps is enabled
   * to be triggered, when the system is not able to decode frames within a
   * specific tolerance of the fps of the video and disables LCEVC decoding
   * for some time. The base video will be shown upscaled to target resolution.
   * If it is triggered again within a short period of time, the disabled
   * time will be higher and if it is triggered three times in a row the LCEVC
   * decoding will be disabled for that playback session.
   * If dynamicPerformanceScaling is false, LCEVC decode will be forced
   * and will drop frames appropriately if performance is sub optimal.
   * Defaults to <code>true</code>.
   */
  dynamicPerformanceScaling: boolean;
  /**
   * Loglevel 0-5 for logging.
   * NONE = 0
   * ERROR = 1
   * WARNING = 2
   * INFO = 3
   * DEBUG = 4
   * VERBOSE = 5
   * Defaults to <code>0</code>.
   */
  logLevel: number;
  /**
   * If <code>true</code>, LCEVC Logo is placed on the top left hand corner
   * which only appears when the LCEVC enhanced frames are being rendered.
   * Defaults to true for the lib but is forced to false in this integration
   * unless explicitly set to true through config.
   * Defaults to <code>false</code>.
   */
  drawLogo: boolean;
}

// TODO(sanfeng): Offline
export interface OfflineConfiguration {}

export interface PlayerConfiguration {
  /**
   * Ads configuration and settings.
   */
  ads: AdsConfiguration;

  /**
   * Controls behavior of auto-showing text tracks on load().
   */
  autoShowText: AutoShowText;

  //  DRM configuration and settings.
  drm: DrmConfiguration | null;

  // Manifest configuration and settings.
  manifest: ManifestConfiguration;

  // Streaming configuration and settings.
  streaming: StreamingConfiguration;
  // Media source configuration and settings.
  mediaSource: MediaSourceConfiguration;
  // A factory to construct an abr manager.
  abrFactory: AbrManagerFactory;
  // ABR configuration and settings.
  abr: AbrConfiguration;
  cmcd: CmcdConfiguration;
  cmsd: CmsdConfiguration;
  offline: OfflineConfiguration;
  lcevc: LcevcConfiguration;
  /**
   * The preferred language to use for audio tracks.  If not given it will use
   * the <code>'main'</code> track.
   * Changing this during playback will not affect the current playback.
   */
  preferredAudioLanguage: string;
  /**
   * The preferred label to use for audio tracks
   */
  preferredAudioLabel: string;
  // The preferred label to use for video tracks
  preferredVideoLabel: string;
  /**
   * The preferred language to use for text tracks.  If a matching text track
   * is found, and the selected audio and text tracks have different languages,
   * the text track will be shown.
   * Changing this during playback will not affect the current playback.
   */
  preferredTextLanguage: string;
  // The preferred role to use for variants.
  preferredVariantRole: string;
  // The preferred role to use for text tracks.
  preferredTextRole: string;
  // The list of preferred video codecs, in order of highest to lowest priority.
  preferredVideoCodecs: string[];
  // The list of preferred audio codecs, in order of highest to lowest priority.
  preferredAudioCodecs: string[];

  // The preferred number of audio channels.
  preferredAudioChannelCount: number;
  /**
   * The preferred HDR level of the video. If possible, this will cause the
   * player to filter to assets that either have that HDR level, or no HDR level
   * at all.
   * Can be 'SDR', 'PQ', 'HLG', 'AUTO' for auto-detect, or '' for no preference.
   * Defaults to 'AUTO'.
   * Note that one some platforms, such as Chrome, attempting to play PQ content
   * may cause problems.
   */
  preferredVideoHdrLevel: string;
  /**
   * The preferred video layout of the video.
   * Can be 'CH-STEREO', 'CH-MONO', or '' for no preference.
   * If the content is predominantly stereoscopic you should use 'CH-STEREO'.
   * If the content is predominantly monoscopic you should use 'CH-MONO'.
   * Defaults to ''.
   */
  preferredVideoLayout: string;
  /**
   * The list of preferred attributes of decodingInfo, in the order of their
   * priorities.
   */
  preferredDecodingAttributes: string[];
  /**
   * If true, a forced text track is preferred.  Defaults to false.
   * If the content has no forced captions and the value is true,
   * no text track is chosen.
   * Changing this during playback will not affect the current playback.
   */
  preferForcedSubs: boolean;
  /**
   * If true, a spatial audio track is preferred.  Defaults to false.
   */
  preferSpatialAudio: boolean;
  /**
   * The application restrictions to apply to the tracks.  These are "hard"
   * restrictions.  Any track that fails to meet these restrictions will not
   * appear in the track list.  If no tracks meet these restrictions, playback
   * will fail.
   */
  restrictions: Restrictions;

  /**
   * Optional playback and seek start time in seconds. Defaults to 0 if
   * not provided.
   */
  playRangeStart: number;

  /**
   * Optional playback and seek end time in seconds. Defaults to the end of
   * the presentation if not provided.
   */
  playRangeEnd: number;
  // Text displayer configuration and settings.
  textDisplayer: TextDisplayerConfiguration;
  /**
   * A factory to construct a text displayer. Note that, if this is changed
   * during playback, it will cause the text tracks to be reloaded.
   */
  textDisplayFactory: TextDisplayerFactory;
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
  mimeType: string | null;
  pictureType: number | null;
}

export interface Resolution {
  //  Width in pixels.
  width: number;
  //  Height in pixels.
  height: number;
}

/**
 * An object describing a media track.  This object should be treated as
 * read-only as changing any values does not have any effect.  This is the
 * public view of an audio/video paring (variant type) or text track (text
 * type) or image track (image type).
 */
export interface Track {
  // The unique ID of the track.
  id: number;
  /**
   * If true, this is the track being streamed (another track may be
   * visible/audible in the buffer).
   */
  active: boolean;
  /**
   * The type of track, either <code>'variant'</code> or <code>'text'</code>
   * or <code>'image'</code>.
   */
  type: string;

  // The bandwidth required to play the track, in bits/sec.
  bandwidth: number;
  /**
   * The language of the track, or <code>'und'</code> if not given.  This value
   *   is normalized as follows - language part is always lowercase and translated
   *   to ISO-639-1 when possible, locale part is always uppercase,
   *   i.e. <code>'en-US'</code>.
   */
  language: string;
  // The track label, which is unique text that should describe the track.
  label: string | null;
  /**
   * (only for text tracks) The kind of text track, either
   *   <code>'caption'</code> or <code>'subtitle'</code>.
   */
  kind: string | null;
  // The video width provided in the manifest, if present.
  width: number | null;
  // The video height provided in the manifest, if present.
  height: number | null;
  // The video framerate provided in the manifest, if present.
  frameRate: number | null;
  // The video pixel aspect ratio provided in the manifest, if present.
  pixelAspectRatio: string | null;
  // The video HDR provided in the manifest, if present.
  hdr: string | null;
  // The video color gamut provided in the manifest, if present.
  colorGamut: string | null;
  // The video layout provided in the manifest, if present.
  videoLayout: string | null;
  // The MIME type of the content provided in the manifest.
  mimeType: string | null;
  // The audio MIME type of the content provided in the manifest.
  audioMimeType: string | null;
  // The video MIME type of the content provided in the manifest.
  videoMimeType: string | null;
  // The audio/video codecs string provided in the manifest, if present.
  codecs: string | null;
  // The audio codecs string provided in the manifest, if present.
  audioCodec: string | null;
  // The video codecs string provided in the manifest, if present.
  videoCodec: string | null;
  /**
   * True indicates that this in the primary language for the content.
   *   This flag is based on signals from the manifest.
   *   This can be a useful hint about which language should be the default, and
   *   indicates which track Shaka will use when the user's language preference
   *   cannot be satisfied.
   */
  primary: boolean;
  /**
   * The roles of the track, e.g. <code>'main'</code>, <code>'caption'</code>,
   *   or <code>'commentary'</code>.
   */
  roles: string[] | null;
  /**
   * The roles of the audio in the track, e.g. <code>'main'</code> or
   *   <code>'commentary'</code>. Will be null for text tracks or variant tracks
   *   without audio.
   */
  audioRoles: string[] | null;
  /**
   *   The DASH accessibility descriptor, if one was provided for this track.
   *   For text tracks, this describes the text; otherwise, this is for the audio.
   */
  accessibilityPurpose: AccessibilityPurpose | null;
  /**
   * True indicates that this in the forced text language for the content.
   *   This flag is based on signals from the manifest.
   */
  forced: boolean;
  // (only for variant tracks) The video stream id.
  videoId: number | null;
  // (only for variant tracks) The audio stream id.
  audioId: number | null;
  // The count of the audio track channels.
  channelsCount: number | null;
  // Specifies the maximum sampling rate of the content.
  audioSamplingRate: number | null;
  /**
   * The value is a grid-item-dimension consisting of two positive decimal
   *   integers in the format: column-x-row ('4x3'). It describes the arrangement
   *   of Images in a Grid. The minimum valid LAYOUT is '1x1'.
   */
  tilesLayout: string | null;
  /**
   * True indicates that the content has spatial audio.
   *   This flag is based on signals from the manifest.
   */
  spatialAudio: boolean;
  //  (only for variant tracks) The audio stream's bandwidth if known.
  audioBandwidth: number | null;
  // (only for variant tracks) The video stream's bandwidth if known.
  videoBandwidth: number | null;
  /**
   * (variant tracks only) The original ID of the video part of the track, if
   *   any, as it appeared in the original manifest.
   */
  originalVideoId: string | null;
  /**
   * (variant tracks only) The original ID of the audio part of the track, if
   *   any, as it appeared in the original manifest.
   */
  originalAudioId: string | null;
  /**
   * (text tracks only) The original ID of the text track, if any, as it
   *   appeared in the original manifest.
   */
  originalTextId: string | null;
  /**
   * (image tracks only) The original ID of the image track, if any, as it
   *   appeared in the original manifest.
   */
  originalImageId: string | null;
  /**
   * The original language of the track, if any, as it appeared in the original
   *   manifest.  This is the exact value provided in the manifest; for normalized
   *   value use <code>language</code> property.
   */
  originalLanguage: string | null;
}

export type TrackList = Track[];

/**
 * Contains the times of a range of buffered content.
 */
export interface BufferedRange {
  // The start time of the range, in seconds.
  start: number;
  // The end time of the range, in seconds.
  end: number;
}

/**
 * Contains information about the current buffered ranges.
 */
export interface BufferedInfo {
  /**
   * The combined audio/video buffered ranges, reported by
   *   <code>video.buffered</code>.
   */
  total: BufferedRange[];
  /**
   *  The buffered ranges for audio content.
   */
  audio: BufferedRange[];
  //  The buffered ranges for video content.
  video: BufferedRange[];
  /**
   * The buffered ranges for text content.
   */
  text: BufferedRange[];
}

export interface StateChange {
  /**
   * The timestamp the state was entered, in seconds since 1970
   *   (i.e. <code>Date.now() / 1000</code>).
   */
  timestamp: number;
  /**
   * The state the player entered.  This could be <code>'buffering'</code>,
   *   <code>'playing'</code>, <code>'paused'</code>, or <code>'ended'</code>.
   */
  state: string;
  /**
   * The number of seconds the player was in this state.  If this is the last
   *   entry in the list, the player is still in this state, so the duration will
   *   continue to increase.
   */
  duration: number;
}

export interface TrackChoice {
  /**
   * The timestamp the choice was made, in seconds since 1970
   *   (i.e. <code>Date.now() / 1000</code>).
   */
  timestamp: number;
  /**
   * The id of the track that was chosen.
   */
  id: number;
  /**
   * The type of track chosen (<code>'variant'</code> or <code>'text'</code>).
   */
  type: string;
  /**
   * <code>true</code> if the choice was made by AbrManager for adaptation;
   *   <code>false</code> if it was made by the application through
   *   <code>selectTrack</code>.
   */
  fromAdaptation: boolean;
  /**
   * The bandwidth of the chosen track (<code>null</code> for text).
   */
  bandwidth: number | null;
}

/**
 * Contains statistics and information about the current state of the player.
 * This is meant for applications that want to log quality-of-experience (QoE)
 * or other stats.  These values will reset when <code>load()</code> is called
 * again.
 *
 */
export interface StatsInfo {
  /**
   *  The width of the current video track. If nothing is loaded or the content
   *   is audio-only, NaN.
   */
  width: number;
  /**
   * The height of the current video track. If nothing is loaded or the content
   *   is audio-only, NaN.
   */
  height: number;
  /**
   *  The bandwidth required for the current streams (total, in bit/sec).
   *   It takes into account the playbackrate. If nothing is loaded, NaN.
   *
   */
  streamBandwidth: number;
  /**
   * The total number of frames decoded by the Player. If not reported by the
   *   browser, NaN.
   */
  decodedFrames: number;
  /**
   * The total number of frames dropped by the Player. If not reported by the
   *   browser, NaN.
   */
  droppedFrames: number;
  /**
   *  The total number of corrupted frames dropped by the browser. If not
   *   reported by the browser, NaN.
   */
  corruptedFrames: number;
  /**
   * The current estimated network bandwidth (in bit/sec). If no estimate
   *   available, NaN.
   */
  estimatedBandwidth: number;
  /**
   * The total number of playback gaps jumped by the GapJumpingController.
   *   If nothing is loaded, NaN.
   */
  gapsJumped: number;
  /**
   *  The total number of playback stalls detected by the StallDetector.
   *   If nothing is loaded, NaN.
   */
  stallsDetected: number;
  /**
   *  This is the greatest completion percent that the user has experienced in
   *   playback. Also known as the "high water mark". If nothing is loaded, or
   *   the stream is live (and therefore indefinite), NaN.
   */
  completionPercent: number;
  /**
   *  This is the number of seconds it took for the video element to have enough
   *   data to begin playback.  This is measured from the time load() is called to
   *   the time the <code>'loadeddata'</code> event is fired by the media element.
   *   If nothing is loaded, NaN.
   */
  loadLatency: number;
  /**
   * The amount of time it took to download and parse the manifest.
   *   If nothing is loaded, NaN.
   */
  manifestTimeSeconds: number;
  /**
   * The amount of time it took to download the first drm key, and load that key
   *   into the drm system. If nothing is loaded or DRM is not in use, NaN.
   */
  drmTimeSeconds: number;
  /**
   *  The total time spent in a playing state in seconds. If nothing is loaded,
   *   NaN.
   */
  playTime: number;
  /**
   * The total time spent in a paused state in seconds. If nothing is loaded,
   *   NaN.
   */
  pauseTime: number;
  /**
   *  The total time spent in a buffering state in seconds. If nothing is
   *   loaded, NaN.
   */
  bufferingTime: number;
  /**
   *  The time spent on license requests during this session in seconds. If DRM
   *   is not in use, NaN.
   */
  licenseTime: number;
  /**
   * The time between the capturing of a frame and the end user having it
   *   displayed on their screen. If nothing is loaded or the content is VOD,
   *   NaN.
   */
  liveLatency: number;
  /**
   * The presentation's max segment duration in seconds. If nothing is loaded,
   *   NaN.
   */
  maxSegmentDuration: number;
  /**
   *  The bytes downloaded during the playback. If nothing is loaded, NaN.
   */
  bytesDownloaded: number;
  //  A history of the stream changes.
  switchHistory: TrackChoice[];
  // A history of the state changes.
  stateHistory: StateChange[];
  /**
   *  Size of the manifest payload. For DASH & MSS it will match the latest
   *  downloaded manifest. For HLS, it will match the lastly downloaded playlist.
   *  If nothing is loaded or in src= mode, NaN.
   */
  manifestSizeBytes: number;
}

/**
 * ID3 metadata in format defined by
 * https://id3.org/id3v2.3.0#Declared_ID3v2_frames
 * The content of the field.
 */
export interface ID3Metadata {
  cueTime: number | null;
  data: Uint8Array;
  frames: MetadataFrame[];
  dts: number | null;
  pts: number | null;
}

export interface MetadataRawFrame {
  type: string;
  size: number;
  data: Uint8Array;
}
