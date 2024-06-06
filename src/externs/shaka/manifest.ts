import { PresentationTimeline } from '../../lib/media/presentation_timeline';
import { StreamDB } from './offline';

/**
 * @description
 * <p>
 * A Manifest object describes a collection of streams (segmented audio, video,
 * or text data) that share a common timeline. We call the collection of
 * streams "the presentation" and their timeline "the presentation timeline".
 * A Manifest describes one of two types of presentations: live and
 * video-on-demand.
 * 共享一个timeline的流的集合称为 the presentation, 它们的timeline称为the presentation timeline
 * </p>
 *
 * <p>
 * A live presentation begins at some point in time and either continues
 * indefinitely or ends when the presentation stops broadcasting. For a live
 * presentation, wall-clock time maps onto the presentation timeline, and the
 * current wall-clock time maps to the live-edge (AKA "the current presentation
 * time"). In contrast, a video-on-demand presentation exists entirely
 * independent of wall-clock time.
 *  wall-clock time和the presentation timeline 之间的关系
 * </p>
 *
 * <p>
 * A variant is a combination of an audio and a video streams that can be played
 * together.
 * 可以放弃一起播放的视频流和音频流称为variant
 * </p>
 *
 * <p>
 * A stream has the same logical content as another stream if the only
 * difference between the two is their quality. For example, an SD video stream
 * and an HD video stream that depict(描绘) the same scene have the same logical
 * content; whereas an English audio stream and a French audio stream have
 * different logical contents. The player can automatically switch between
 * streams which have the same logical content to adapt to network conditions.
 * 可以根据网络切换相同逻辑内容的流
 * </p>
 */

export interface Manifest {
  /**
   * <i>Required.</i> <br>
   * The presentation timeline.
   */
  presentationTimeline: PresentationTimeline;
  /**
   * <i>Required.</i> <br>
   * The presentation's Variants. There must be at least one Variant.
   */
  variants: Variant[];
  /**
   * <i>Required.</i> <br>
   * The presentation's text streams.
   */
  textStreams: Stream[];
  /**
   * <i>Required.</i> <br>
   * The presentation's image streams
   */
  imageStreams: Stream[];
  /**
   * <i>Defaults to [].</i> <br>
   * An array of EME sessions to load for offline playback.
   */
  offlineSessionIds: string[];
  /**
   * <i>Defaults to 0.</i> <br>
   * The minimum number of seconds of content that must be buffered before
   * playback can begin.  Can be overridden by a higher value from the Player
   * configuration.
   */
  minBufferTime: number;

  /**
   * If true, we will append the media segments using sequence mode; that is to
   * say, ignoring any timestamps inside the media files.
   */
  sequenceMode: number;

  /**
   * If true, don't adjust the timestamp offset to account for manifest
   * segment durations being out of sync with segment durations. In other
   * words, assume that there are no gaps in the segments when appending
   * to the SourceBuffer, even if the manifest and segment times disagree.
   * Only applies when sequenceMode is <code>false</code>, and only for HLS
   * streams.
   * <i>Defaults to <code>false</code>.</i>
   */
  ignoreManifestTimestampsInSegmentsMode: boolean;
  /**
   *  Indicates the type of the manifest. It can be <code>'HLS'</code> or
   *  <code>'DASH'</code>.
   */
  type: string;
  /**
   * The service description for the manifest. Used to adapt playbackRate to
   * decrease latency.
   */
  serviceDescription: number;
  // The next url to play.
  nextUrl?: string;
}

/**
 * Maximum and minimum latency and playback rate for a manifest. When max
 * latency is reached playbackrate is updated to maxPlaybackRate to decrease
 * latency. When min  latency is reached playbackrate is updated to
 * minPlaybackRate to increase  latency.
 * 当达到最大延迟时，播放速率将更新至maxPlaybackRate以减少延迟。当达到最小延迟时，
 * 播放速率将更新至minPlaybackRate以增加延迟。
 * More information {@link https://dashif.org/docs/CR-Low-Latency-Live-r8.pdf here}.
 */
export interface ServiceDescription {
  // The target latency to aim for.
  targetLatency?: number;
  // Maximum latency in seconds.
  maxLatency?: number;
  // Maximum playback rate.
  maxPlaybackRate?: number;
  // Minimum latency in seconds.
  minLatency?: number;
  // Minimum playback rate.
  minPlaybackRate?: number;
}

/**

 * @description
 * Explicit initialization data, which override any initialization data in the
 * content. The initDataType values and the formats that they correspond to
 * are specified {@link https://bit.ly/EmeInitTypes here}.
 *
 * @exportDoc
 */
export interface InitDataOverride {
  /**
   * Initialization data in the format indicated by initDataType.
   */
  initData: Uint8Array;
  /**
   * A string to indicate what format initData is in.
   */
  initDataType: string;
  /**
   * The key Id that corresponds to this initData.
   */
  keyId?: string;
}

export interface DrmInfo {
  keySystem: string;
  encryptionScheme: string;
  licenseServerUri: string;
  distinctiveIdentifierRequired: boolean;
  persistentStateRequired: boolean;
  audioRobustness: string;
  videoRobustness: string;
  serverCertificate: Uint8Array | null;
  serverCertificateUri: string;
  sessionType: string;
  initData: Array<InitDataOverride>;
  keyIds: Set<string>;
}

/**
 * Creates a SegmentIndex; returns a Promise that resolves after the
 * SegmentIndex has been created.
 *
 * @exportDoc
 */
type CreateSegmentIndexFunction = () => Promise<any>;

/**
 * @description A Stream object describes a single stream (segmented media data).
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

/**
 * A Variant describes a combination of an audio and video streams which
 * could be played together. It's possible to have a video/audio only
 * variant.
 */
export interface Variant {
  /**
   * A unique ID among all Variant objects within the same Manifest.
   */
  id: number;
  /**
   * <i>Defaults to '' (i.e., unknown).</i> <br>
   * The Variant's language, specified as a language code. <br>
   * See {@link https://tools.ietf.org/html/rfc5646} <br>
   * See {@link http://www.iso.org/iso/home/standards/language_codes.htm}
   */
  language: string;
  /*
   * <i>Defaults to 0.</i> <br>
   * 0 means the variant is enabled. The Player will set this value to
   * "(Date.now() / 1000) + config.streaming.maxDisabledTime" and once this
   * maxDisabledTime has passed Player will set the value to 0 in order to
   * reenable the variant.
   */
  disabledUntilTime: number;
  /**
   * <i>Defaults to false.</i> <br>
   * True indicates that the player should use this Variant over others if user
   * preferences cannot be met.  The player may still use another Variant to
   * meet user preferences.
   */
  primary: boolean;
  /**
   * The audio stream of the variant.
   */
  audio: Stream;
  /**
   * The video stream of the variant.
   */
  video: Stream;
  /**
   * The variant's required bandwidth in bits per second.
   */
  bandwidth: number;
  /**
   * <i>Defaults to true.</i><br>
   * Set by the Player to indicate whether the variant is allowed to be played
   *  by the application.
   */
  allowedByApplication: boolean;
  /**
   * <i>Defaults to true.</i><br>
   * Set by the Player to indicate whether the variant is allowed to be played
   * by the key system.
   */
  allowedByKeySystem: boolean;
  /**
   * <i>Defaults to [].</i><br>
   * Set by StreamUtils to indicate the results from MediaCapabilities
   * decodingInfo
   */
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

export type FetchCryptoKeysFunction = () => Promise<void>;
/**
 * @description AES key and iv info from the manifest.
 */
export interface AesKey {
  /**
   * The number of the bit key (eg: 128, 256).
   */
  bitsKey: number;
  /**
   * The block cipher mode of operation. Possible values: 'CTR' or 'CBC'.
   */
  blockCipherMode: string;
  /**
   * Web crypto key object of the AES key. If unset, the "fetchKey"
   * property should be provided.
   */
  cryptoKey: CryptoKey | undefined;
  /**
   * A function that fetches the key.
   * Should be provided if the "cryptoKey" property is unset.
   * Should update this object in-place, to set "cryptoKey".
   */
  fetchKey?: CreateSegmentIndexFunction;
  /**
   * The IV in the manifest, if defined. For HLS see HLS RFC 8216 Section 5.2
   * for handling undefined IV.
   */
  iv?: Uint8Array;
  /**
   * The starting Media Sequence Number of the playlist, used when IV is
   * undefined.
   */
  firstMediaSequenceNumber: number;
}
