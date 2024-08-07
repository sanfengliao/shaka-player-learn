import { asserts } from './debug/asserts';
import { PreloadManager, PreloadManagerPlayerInterface } from './media/preload_manager';
import {
  NetworkingEngine,
  NetworkingEngineRequestType,
  OnDownloadFailed,
  OnHeadersReceived,
  OnProgressUpdated,
  OnRequest,
  OnResponse,
  OnRetry,
} from './net/network_engine';
import { ShakaError as ShakaError } from './util/error';
import { EventManager } from './util/event_manager';
import { FakeEvent } from './util/fake_event';
import { FakeEventTarget } from './util/fake_event_target';
import { Mutex } from './util/mutex';
import { Platform } from './util/platform';
import {
  BufferedInfo,
  ID3Metadata,
  PlayerConfiguration as IPlayerConfiguration,
  Interstitial,
  MediaQualityInfo,
  MetadataFrame,
  Resolution,
  TimelineRegionInfo,
  Track,
} from '../externs/shaka/player';
import { PlayerConfiguration } from './util/player_configuration';
import { log } from './debug/log';
import { Manifest, Stream, Variant } from '../externs/shaka/manifest';
import { MediaSourceEngine, OnMetadata } from './media/media_source_engine';
import { TextDisplayer } from '../externs/shaka/text';
import { IDestroyable } from './util/i_destroyable';
import { MediaSourcePlayhead, Playhead, SrcEqualsPlayhead } from './media/playhead';
import { PlayheadObserverManager } from './media/playhead_observer';
import { PlayRateController } from './media/play_rate_controller';
import { Timer } from './util/timer';
import { BufferingObserver, BufferingObserverState } from './media/buffering_observer';
import { RegionTimeline } from './media/region_timeline';
import { QualityObserver } from './media/quality_observer';
import { StreamingEngine, StreamingEnginePlayerInterface } from './media/stream_engine';
import {
  IManifestParser,
  ManifestParserFactory,
  ManifestParserPlayerInterface,
} from '../externs/shaka/manifest_parser';
import { AbrManager, AbrManagerFactory } from '../externs/shaka/abr_manager';
import { ManifestFilterer } from './media/manifest_filterer';
import { Stats } from './media/stats';
import { AdaptationSetCriteria, PreferenceBasedCriteria } from './media/adaptation_set_criteria';
import { Deprecate } from './deprecate/deprecate';
import { NetworkingUtils } from './net/network_util';
import { ManifestParser } from './media/manifest_parser';
import { ObjectUtils } from './util/object_utils';
import { ConfigUtils } from './util/config_utils';
import { DrmEngine } from './media/drm_engtine';
import { TimeRangesUtils } from './media/time_range_utils';
import { StreamUtils } from './util/stream_utils';
import { Dom } from './util/dom_utils';
import { MimeUtils } from './util/mime_utils';
import { PublicPromise } from './util/public_promise';
import { MediaReadyState } from './util/media_ready_state_utils';
import { SegmentPrefetch } from './media/segment_prefetch';
import { PresentationTimeline } from './media/presentation_timeline';
import { RegionObserver } from './media/region_observer';

export class Player extends FakeEventTarget implements IDestroyable {
  static LoadMode = {
    DESTROYED: 0,
    NOT_LOADED: 1,
    MEDIA_SOURCE: 2,
    SRC_EQUALS: 3,
  } as const;

  private loadMode_: number = Player.LoadMode.NOT_LOADED;
  private video_: HTMLMediaElement = null as any;
  private videoContainer_: HTMLElement = null as any;
  /**
   * Since we may not always have a text displayer created (e.g. before |load|
   * is called), we need to track what text visibility SHOULD be so that we
   * can ensure that when we create the text displayer. When we create our
   * text displayer, we will use this to show (or not show) text as per the
   * user's requests.
   * TODO(sanfeng): TextEngine
   */
  private isTextVisible_ = false;

  /**
   * For listeners scoped to the lifetime of the Player instance.
   */
  private globalEventManager_ = new EventManager();

  /**
   * For listeners scoped to the lifetime of the media element attachment.
   */
  private attachEventManager_ = new EventManager();

  /**
   * For listeners scoped to the lifetime of the loaded content.
   */
  private loadEventManager_ = new EventManager();

  /**
   *  For listeners scoped to the lifetime of the loaded content.
   */
  private trickPlayEventManager_ = new EventManager();

  /**
   * For listeners scoped to the lifetime of the ad manager.
   * TODO(sanfeng): AdManager
   */
  // this.adManagerEventManager_ = new EventManager();

  private networkingEngine_: NetworkingEngine = null as any;
  /**
   * TODO(sanfeng): DrmEngine
   */
  // this.drmEngine_ = null as any;

  private mediaSourceEngine_: MediaSourceEngine = null as any;

  private playhead_: Playhead = null as any;

  /**
   * Incremented whenever a top-level operation (load, attach, etc) is
   * performed.
   * Used to determine if a load operation has been interrupted.
   */
  private operationId_ = 0;

  private mutex_ = new Mutex();

  /**
   * The playhead observers are used to monitor the position of the playhead
   * and some other source of data (e.g. buffered content), and raise events.
   *
   */
  private playheadObservers_: PlayheadObserverManager = null as any;

  /**
   * This is our control over the playback rate of the media element. This
   * provides the missing functionality that we need to provide trick play,
   * for example a negative playback rate.
   */
  private playRateController_: PlayRateController = null as any;

  // We use the buffering observer and timer to track when we move from having
  // enough buffered content to not enough. They only exist when content has
  // been loaded and are not re-used between loads.

  private bufferPoller_: Timer = null as any;

  private bufferObserver_: BufferingObserver = null as any;

  private regionTimeline_: RegionTimeline = null as any;
  // TODO(sanfeng): CmcdManager
  // private cmcdManager_: CmcdManager = null as any;
  // TODO(sanfeng): CmsdManager
  // private cmsdManager_: CmsdManager = null as any;

  private qualityObserver_: QualityObserver = null as any;

  private streamingEngine_: StreamingEngine = null as any;

  private parser_: IManifestParser = null as any;

  private parserFactory_: ManifestParserFactory = null as any;

  private manifest_: Manifest = null as any;

  private assetUri_: string | null = null;

  private mimeType_: string | null = null;

  private startTime_: number | null = null;

  private fullyLoaded_ = false;

  private abrManager_: AbrManager = null as any;

  /**
   * The factory that was used to create the abrManager_ instance.
   */
  private abrManagerFactory_: AbrManagerFactory = null as any;

  /**
   * Contains an ID for use with creating streams.  The manifest parser should
   * start with small IDs, so this starts with a large one.
   */
  private nextExternalStreamId_ = 1e9;

  private externalSrcEqualsThumbnailsStreams_: Stream[] = [];
  private completionPercent_ = NaN;
  private config_: IPlayerConfiguration;

  private maxHwRes_: Resolution = { width: Infinity, height: Infinity };

  /**
   * The TextDisplayerFactory that was last used to make a text displayer.
   * Stored so that we can tell if a new type of text displayer is desired.
   * TODO(sanfeng): TextEngine
   */
  private lastTextFactory_: TextDisplayer | null = null;
  private manifestFilterer_: ManifestFilterer;

  private createdPreloadManagers_: PreloadManager[] = [];

  private stats_: Stats = null as any;

  private currentAdaptationSetCriteria_: AdaptationSetCriteria;

  private currentTextLanguage_: string;

  private currentTextRole_: string;

  private currentTextForced_: boolean;

  private cleanupOnUnload_: (() => Promise<void> | void)[] = [];

  // TODO(sanfeng): AdManager
  // private adManager_: IAdManager = null as any;

  private preloadDueAdManager_: PreloadManager | null = null;

  // TODO(sanfeng): AdManager
  // private preloadDueAdManagerVideo_: HTMLMediaElement= null as any;
  // private preloadDueAdManagerVideoEnded_ = false

  private checkVariantsTimer_: Timer;
  private preloadNextUrl_: PreloadManager | null = null;

  constructor(mediaElement?: HTMLMediaElement) {
    super();

    this.config_ = this.defaultConfig_();

    this.manifestFilterer_ = new ManifestFilterer(this.config_, this.maxHwRes_, null);

    this.currentAdaptationSetCriteria_ = new PreferenceBasedCriteria(
      this.config_.preferredAudioLanguage,
      this.config_.preferredVariantRole,
      this.config_.preferredAudioChannelCount,
      this.config_.preferredVideoHdrLevel,
      this.config_.preferSpatialAudio,
      this.config_.preferredVideoLayout,
      this.config_.preferredAudioLabel,
      this.config_.preferredVideoLabel,
      this.config_.mediaSource.codecSwitchingStrategy,
      this.config_.manifest.dash.enableAudioGroups
    );

    this.currentTextLanguage_ = this.config_.preferredTextLanguage;
    this.currentTextRole_ = this.config_.preferredTextRole;

    this.currentTextForced_ = this.config_.preferForcedSubs;

    // Create the CMCD manager so client data can be attached to all requests
    // TODO(sanfeng): CMCDManager
    // this.cmcdManager_ = this.createCmcd_();
    // TODO(sanfeng): CMSDManager
    // this.cmsdManager_ = this.createCmsd_();

    this.networkingEngine_ = this.createNetworkingEngine();
    this.networkingEngine_.setForceHTTP(this.config_.streaming.forceHTTP);
    this.networkingEngine_.setForceHTTPS(this.config_.streaming.forceHTTPS);
    // TODO(sanfeng): AdManager
    // this.preloadDueAdManagerTimer_ = new util.Timer(async () => {
    //   if (this.preloadDueAdManager_) {
    //     goog.asserts.assert(this.preloadDueAdManagerVideo_, 'Must have video');
    //     await this.attach(
    //         this.preloadDueAdManagerVideo_, /* initializeMediaSource= */ true);
    //     await this.load(this.preloadDueAdManager_);
    //     if (!this.preloadDueAdManagerVideoEnded_) {
    //       this.preloadDueAdManagerVideo_.play();
    //     } else {
    //       this.preloadDueAdManagerVideo_.pause();
    //     }
    //     this.preloadDueAdManager_ = null;
    //     this.preloadDueAdManagerVideoEnded_ = false;
    //   }
    // });

    // if (Player.adManagerFactory_) {
    //   this.adManager_ = Player.adManagerFactory_();
    //   this.adManager_.configure(this.config_.ads);

    //   // Note: we don't use ads.AdManager.AD_CONTENT_PAUSE_REQUESTED to
    //   // avoid add a optional module in the player.
    //   this.adManagerEventManager_.listen(
    //       this.adManager_, 'ad-content-pause-requested', async (e) => {
    //         this.preloadDueAdManagerTimer_.stop();
    //         if (!this.preloadDueAdManager_) {
    //           this.preloadDueAdManagerVideo_ = this.video_;
    //           this.preloadDueAdManagerVideoEnded_ = this.video_.ended;
    //           const saveLivePosition = /** @type {boolean} */(
    //             e['saveLivePosition']) || false;
    //           this.preloadDueAdManager_ = await this.detachAndSavePreload(
    //               /* keepAdManager= */ true, saveLivePosition);
    //         }
    //       });

    //   // Note: we don't use ads.AdManager.AD_CONTENT_RESUME_REQUESTED to
    //   // avoid add a optional module in the player.
    //   this.adManagerEventManager_.listen(
    //       this.adManager_, 'ad-content-resume-requested', (e) => {
    //         const offset = /** @type {number} */(e['offset']) || 0;
    //         if (this.preloadDueAdManager_) {
    //           this.preloadDueAdManager_.setOffsetToStartTime(offset);
    //         }
    //         this.preloadDueAdManagerTimer_.tickAfter(0.1);
    //       });

    //   // Note: we don't use ads.AdManager.AD_CONTENT_ATTACH_REQUESTED to
    //   // avoid add a optional module in the player.
    //   this.adManagerEventManager_.listen(
    //       this.adManager_, 'ad-content-attach-requested', async (e) => {
    //         if (!this.video_ && this.preloadDueAdManagerVideo_) {
    //           goog.asserts.assert(this.preloadDueAdManagerVideo_,
    //               'Must have video');
    //           await this.attach(this.preloadDueAdManagerVideo_,
    //               /* initializeMediaSource= */ true);
    //         }
    //       });
    // }

    this.globalEventManager_.listen(window, 'online', () => {
      this.restoreDisabledVariants_();
      this.retryStreaming();
    });

    this.checkVariantsTimer_ = new Timer(() => {
      this.checkVariants_();
    });

    // Even though |attach| will start in later interpreter cycles, it should be
    // the LAST thing we do in the constructor because conceptually it relies on
    // player having been initialized.
    if (mediaElement) {
      Deprecate.deprecateFeature(
        5,
        'Player w/ mediaElement',
        'Please migrate from initializing Player with a mediaElement; ' + 'use the attach method instead.'
      );
      this.attach(mediaElement, /* initializeMediaSource= */ true);
    }
  }

  /**
   * Retry streaming after a streaming failure has occurred. When the player has
   * not loaded content or is loading content, this will be a no-op and will
   * return <code>false</code>.
   *
   * <p>
   * If the player has loaded content, and streaming has not seen an error, this
   * will return <code>false</code>.
   *
   * <p>
   * If the player has loaded content, and streaming seen an error, but the
   * could not resume streaming, this will return <code>false</code>.
   *
   * @param {number=} retryDelaySeconds
   * @return {boolean}
   * @export
   */
  retryStreaming(retryDelaySeconds = 0.1) {
    return this.loadMode_ === Player.LoadMode.MEDIA_SOURCE ? this.streamingEngine_.retry(retryDelaySeconds) : false;
  }

  /**
   * Checks to re-enable variants that were temporarily disabled due to network
   * errors. If any variants are enabled this way, a new variant may be chosen
   * for playback.
   * @private
   */
  private checkVariants_() {
    asserts.assert(this.manifest_, 'Should have manifest!');

    const now = Date.now() / 1000;
    let hasVariantUpdate = false;

    const streamsAsString = (variant: Variant) => {
      let str = '';
      if (variant.video) {
        str += 'video:' + variant.video.id;
      }
      if (variant.audio) {
        str += str ? '&' : '';
        str += 'audio:' + variant.audio.id;
      }
      return str;
    };

    let shouldStopTimer = true;
    for (const variant of this.manifest_.variants) {
      if (variant.disabledUntilTime > 0 && variant.disabledUntilTime <= now) {
        variant.disabledUntilTime = 0;
        hasVariantUpdate = true;

        log.v2('Re-enabled variant with ' + streamsAsString(variant));
      }
      if (variant.disabledUntilTime > 0) {
        shouldStopTimer = false;
      }
    }

    if (shouldStopTimer) {
      this.checkVariantsTimer_.stop();
    }

    if (hasVariantUpdate) {
      // Reconsider re-enabled variant for ABR switching.
      this.chooseVariantAndSwitch_(
        /* clearBuffer= */ false,
        /* safeMargin= */ undefined,
        /* force= */ false,
        /* fromAdaptation= */ false
      );
    }
  }

  async destroy() {
    // Make sure we only execute the destroy logic once.
    if (this.loadMode_ === Player.LoadMode.DESTROYED) {
      return;
    }
    const detachPromise = this.detach();

    // Mark as "dead". This should stop external-facing calls from changing our
    // internal state any more. This will stop calls to |attach|, |detach|, etc.
    // from interrupting our final move to the detached state.
    this.loadMode_ = Player.LoadMode.DESTROYED;

    await detachPromise;

    // Tear-down the event managers to ensure handlers stop firing.
    if (this.globalEventManager_) {
      this.globalEventManager_.release();
      this.globalEventManager_ = null as any;
    }
    if (this.attachEventManager_) {
      this.attachEventManager_.release();
      this.attachEventManager_ = null as any;
    }
    if (this.loadEventManager_) {
      this.loadEventManager_.release();
      this.loadEventManager_ = null as any;
    }
    if (this.trickPlayEventManager_) {
      this.trickPlayEventManager_.release();
      this.trickPlayEventManager_ = null as any;
    }
    // TODO(sanfeng): AdManager
    // if (this.adManagerEventManager_) {
    //   this.adManagerEventManager_.release();
    //   this.adManagerEventManager_ = null;
    // }

    // this.abrManagerFactory_ = null;
    this.config_ = null as any;
    this.stats_ = null as any;
    this.videoContainer_ = null as any;
    // TODO(sanfeng): CmcdManager
    // this.cmcdManager_ = null as any;
    // TODO(sanfeng): CmsdManager
    // this.cmsdManager_ = null as any;

    if (this.networkingEngine_) {
      await this.networkingEngine_.destroy();
      this.networkingEngine_ = null as any;
    }

    if (this.abrManager_) {
      this.abrManager_.release();
      this.abrManager_ = null as any;
    }

    // FakeEventTarget implements IReleasable
    super.release();
  }

  private defaultConfig_() {
    const config = PlayerConfiguration.createDefault();
    config.streaming.failureCallback = (error) => {};
    return config;
  }

  private defaultStreamingFailureCallback_(error: ShakaError) {
    // For live streams, we retry streaming automatically for certain errors.
    // For VOD streams, all streaming failures are fatal.
    if (!this.isLive()) {
      return;
    }

    let retryDelaySeconds = null;
    if (error.code == ShakaError.Code.BAD_HTTP_STATUS || error.code == ShakaError.Code.HTTP_ERROR) {
      // These errors can be near-instant, so delay a bit before retrying.
      retryDelaySeconds = 1;
      if (this.config_.streaming.lowLatencyMode) {
        retryDelaySeconds = 0.1;
      }
    } else if (error.code == ShakaError.Code.TIMEOUT) {
      // We already waited for a timeout, so retry quickly.
      retryDelaySeconds = 0.1;
    }

    if (retryDelaySeconds != null) {
      error.severity = ShakaError.Severity.RECOVERABLE;
      log.warning('Live streaming error.  Retrying automatically...');
      // TODO(sanfeng): 实现StreamingEngine
      // this.retryStreaming(retryDelaySeconds);
    }
  }

  /**
   * Get if the player is playing live content. If the player has not loaded
   * content, this will return <code>false</code>.
   *
   * @return {boolean}
   * @export
   */
  isLive() {
    if (this.manifest_) {
      return this.manifest_.presentationTimeline.isLive();
    }

    // For native HLS, the duration for live streams seems to be Infinity.
    if (this.video_ && this.video_.src) {
      return this.video_.duration == Infinity;
    }

    return false;
  }
  /**
   * Attaches the player to a media element.
   * If the player was already attached to a media element, first detaches from
   * that media element.
   *
   * @param  mediaElement
   * @param  initializeMediaSource
   */
  async attach(mediaElement: HTMLMediaElement, initializeMediaSource = false) {
    if (this.loadMode_ === Player.LoadMode.DESTROYED) {
      throw this.createAbortLoadError_();
    }

    const noop = this.video_ && this.video_ === mediaElement;
    if (this.video_ && this.video_ !== mediaElement) {
      await this.detach();
    }
    if (await this.atomicOperationAcquireMutex_('attach')) {
      return;
    }
    try {
      if (!noop) {
        this.makeStateChangeEvent_('attach');
        const onError = (event: Event) => this.onVideoError(event);
        this.attachEventManager_.listen(mediaElement, 'error', onError);
        this.video_ = mediaElement;
        if (initializeMediaSource && Platform.supportsMediaSource() && !this.mediaSourceEngine_) {
          await this.initializeMediaSourceEngineInner_();
        }
      }
    } catch (error) {
      this.detach();
      throw error;
    } finally {
      this.mutex_.release();
    }
  }

  /**
   * Set a factory to create an ad manager during player construction time.
   * This method needs to be called bafore instantiating the Player class.
   *
   * TODO(sanfeng): adManager
   * @export
   */
  // static setAdManagerFactory(factory) {
  //   Player.adManagerFactory_ = factory;
  // }

  /**
   * Return whether the browser provides basic support.  If this returns false,
   * Shaka Player cannot be used at all.  In this case, do not construct a
   * Player instance and do not use the library.
   *
   */
  static isBrowserSupported() {
    if (!window.Promise) {
      log.alwaysWarn('A Promise implementation or polyfill is required');
    }

    // Basic features needed for the library to be usable.
    const basicSupport = !!window.Promise && !!window.Uint8Array && !!Array.prototype.forEach;
    if (!basicSupport) {
      return false;
    }

    // We do not support IE
    if (Platform.isIE()) {
      return false;
    }

    const safariVersion = Platform.safariVersion();
    if (safariVersion && safariVersion < 9) {
      return false;
    }

    // DRM support is not strictly necessary, but the APIs at least need to be
    // there.  Our no-op DRM polyfill should handle that.
    // TODO(#1017): Consider making even DrmEngine optional.
    // TODO(sanfeng): DrmEngine
    // const drmSupport = DrmEngine.isBrowserSupported();
    // if (!drmSupport) {
    //   return false;
    // }

    // If we have MediaSource (MSE) support, we should be able to use
    if (Platform.supportsMediaSource()) {
      return true;
    }

    // If we don't have MSE, we _may_ be able to use   Look for native HLS
    // support, and call this platform usable if we have it.
    return Platform.supportsMediaType('application/x-mpegurl');
  }

  /**
   * Probes the browser to determine what features are supported.  This makes a
   * number of requests to EME/MSE/etc which may result in user prompts.  This
   * should only be used for diagnostics.
   *
   * <p>
   * NOTE: This may show a request to the user for permission.
   *
   * @see https://bit.ly/2ywccmH
   */
  static async probeSupport(promptsOkay = true) {
    asserts.assert(Player.isBrowserSupported(), 'Must have basic support');
    const drm = {};
    // TODO(sanfeng): DrmEngine
    // if (promptsOkay) {
    //   drm = await media.DrmEngine.probeSupport();
    // }
    const manifest = ManifestParser.probeSupport();
    const media = MediaSourceEngine.probeSupport();
    const hardwareResolution = await Platform.detectMaxHardwareResolution();

    /** @type {extern.SupportType} */
    const ret = {
      manifest,
      media,
      drm,
      hardwareResolution,
    };

    const plugins = Player.supportPlugins_;
    for (const name in plugins) {
      // @ts-expect-error
      ret[name] = plugins[name]();
    }

    return ret;
  }

  async initializeMediaSourceEngineInner_() {
    asserts.assert(
      Platform.supportsMediaSource(),
      'We should not be initializing media source on a platform that ' + 'does not support media source.'
    );
    asserts.assert(this.video_, 'We should have a media element when initializing media source.');
    asserts.assert(this.mediaSourceEngine_ == null, 'We should not have a media source engine yet.');
    this.makeStateChangeEvent_('media-source');
    // TODO(sanfeng): TextEngine
    const textDisplayerFactory = this.config_.textDisplayFactory;
    const textDisplayer = textDisplayerFactory();
    // When changing text visibility we need to update both the text displayer
    // and streaming engine because we don't always stream text. To ensure
    // that the text displayer and streaming engine are always in sync, wait
    // until they are both initialized before setting the initial value.
    // TODO(sanfeng): TextDisplayer

    const mediaSourceEngine = this.createMediaSourceEngine(this.video_, textDisplayer, (metadata, offset, endTime) => {
      this.processTimedMetadataMediaSrc_(metadata, offset, endTime);
    });
    mediaSourceEngine.configure(this.config_.mediaSource);
    const { segmentRelativeVttTiming } = this.config_.manifest;
    mediaSourceEngine.setSegmentRelativeVttTiming(segmentRelativeVttTiming);

    // Wait for media source engine to finish opening. This promise should
    // NEVER be rejected as per the media source engine implementation.
    await mediaSourceEngine.open();

    // Wait until it is ready to actually store the reference.
    this.mediaSourceEngine_ = mediaSourceEngine;
  }

  private processTimedMetadataMediaSrc_(metadata: ID3Metadata[], offset: number, segmentEndTime: number | null) {
    for (const sample of metadata) {
      if (sample.data && sample.cueTime && sample.frames) {
        const start = sample.cueTime + offset;
        let end = segmentEndTime;
        if (end && start > end) {
          end = start;
        }

        const metadataType = 'org.id3';
        for (const frame of sample.frames) {
          const payload = frame;
          this.dispatchMetadataEvent_(start, end, metadataType, payload);
        }

        // TODO(sanfeng): adManager
        // if (this.adManager_) {
        //   this.adManager_.onHlsTimedMetadata(sample, start);
        // }
      }
    }
  }

  /**
   * Construct and fire a Player.Metadata event
   *
   * @param startTime
   * @param  endTime
   * @param  metadataType
   * @param  payload
   * @private
   */
  dispatchMetadataEvent_(startTime: number, endTime: number | null, metadataType: string, payload: MetadataFrame) {
    asserts.assert(!endTime || startTime <= endTime, 'Metadata start time should be less or equal to the end time!');
    const eventName = FakeEvent.EventName.Metadata;
    const data = new Map()
      .set('startTime', startTime)
      .set('endTime', endTime)
      .set('metadataType', metadataType)
      .set('payload', payload);
    this.dispatchEvent(Player.makeEvent_(eventName, data));
  }

  /**
   * Create a new media source engine. This will ONLY be replaced by tests as a
   * way to inject fake media source engine instances.
   *
   * @param {!HTMLMediaElement} mediaElement
   * @param {!extern.TextDisplayer} textDisplayer
   * @param {!function(!Array.<extern.ID3Metadata>, number, ?number)}
   *  onMetadata
   * @param {lcevc.Dec} lcevcDec
   *
   * @return {!media.MediaSourceEngine}
   */
  createMediaSourceEngine(mediaElement: HTMLMediaElement, textDisplayer: TextDisplayer | null, onMetadata: OnMetadata) {
    return new MediaSourceEngine(mediaElement, textDisplayer, onMetadata);
  }
  /**
   * Detach the player from the current media element. Leaves the player in a
   * state where it cannot play media, until it has been attached to something
   * else.
   *
   */
  async detach(keepAdManager = false) {
    if (this.loadMode_ === Player.LoadMode.DESTROYED) {
      throw this.createAbortLoadError_();
    }

    await this.unload(false, keepAdManager);
    if (await this.atomicOperationAcquireMutex_('detach')) {
      return;
    }
    try {
      if (this.video_) {
        this.attachEventManager_.removeAll();
        this.video_ = null as any;
      }
      this.makeStateChangeEvent_('detach');
      // TODO(sanfeng): AdManager
      // if (this.adManager_ && !keepAdManager) {
      //   this.adManager_.release();
      // }
    } finally {
      this.mutex_.release();
    }
  }

  /**
   * TODO: implement unload
   * Unloads the currently playing stream, if any.
   *
   * @param initializeMediaSource
   * @param keepAdManager
   * @return
   * @export
   */
  async unload(initializeMediaSource = true, keepAdManager = false) {
    // Set the load mode to unload right away so that all the public methods
    // will stop using the internal components. We need to make sure that we
    // are not overriding the destroyed state because we will unload when we are
    // destroying the player.
    if (this.loadMode_ != Player.LoadMode.DESTROYED) {
      this.loadMode_ = Player.LoadMode.NOT_LOADED;
    }

    if (await this.atomicOperationAcquireMutex_('unload')) {
      return;
    }

    try {
      this.fullyLoaded_ = false;
      this.makeStateChangeEvent_('unload');
      // If the platform does not support media source, we will never want to
      // initialize media source.
      if (initializeMediaSource && !Platform.supportsMediaSource()) {
        initializeMediaSource = false;
      }

      // Run any general cleanup tasks now.  This should be here at the top,
      // right after setting loadMode_, so that internal components still exist
      // as they did when the cleanup tasks were registered in the array.
      const cleanupTasks = this.cleanupOnUnload_.map((cb) => cb());
      this.cleanupOnUnload_ = [];
      await Promise.all(cleanupTasks);

      // Dispatch the unloading event.
      this.dispatchEvent(Player.makeEvent_(FakeEvent.EventName.Unloading));

      // Release the region timeline, which is created when parsing the
      // manifest.
      if (this.regionTimeline_) {
        this.regionTimeline_.release();
        this.regionTimeline_ = null as any;
      }

      // In most cases we should have a media element. The one exception would
      // be if there was an error and we, by chance, did not have a media
      // element.
      if (this.video_) {
        this.loadEventManager_.removeAll();
        this.trickPlayEventManager_.removeAll();
      }

      // Stop the variant checker timer
      this.checkVariantsTimer_.stop();

      // Some observers use some playback components, shutting down the
      // observers first ensures that they don't try to use the playback
      // components mid-destroy.
      if (this.playheadObservers_) {
        this.playheadObservers_.release();
        this.playheadObservers_ = null as any;
      }

      if (this.bufferPoller_) {
        this.bufferPoller_.stop();
        this.bufferPoller_ = null as any;
      }

      // Stop the parser early. Since it is at the start of the pipeline, it
      // should be start early to avoid is pushing new data downstream.
      if (this.parser_) {
        await this.parser_.stop();
        this.parser_ = null as any;
        this.parserFactory_ = null as any;
      }

      // Abr Manager will tell streaming engine what to do, so we need to stop
      // it before we destroy streaming engine. Unlike with the other
      // components, we do not release the instance, we will reuse it in later
      // loads.
      if (this.abrManager_) {
        await this.abrManager_.stop();
      }

      // Streaming engine will push new data to media source engine, so we need
      // to shut it down before destroy media source engine.
      if (this.streamingEngine_) {
        await this.streamingEngine_.destroy();
        this.streamingEngine_ = null as any;
      }

      if (this.playRateController_) {
        this.playRateController_.release();
        this.playRateController_ = null as any;
      }

      // Playhead is used by StreamingEngine, so we can't destroy this until
      // after StreamingEngine has stopped.
      if (this.playhead_) {
        this.playhead_.release();
        this.playhead_ = null as any;
      }

      // EME v0.1b requires the media element to clear the MediaKeys
      // TODO(sanfeng): DRMEngine
      // if (util.Platform.isMediaKeysPolyfilled('webkit') && this.drmEngine_) {
      //   await this.drmEngine_.destroy();
      //   this.drmEngine_ = null;
      // }

      // Media source engine holds onto the media element, and in order to
      // detach the media keys (with drm engine), we need to break the
      // connection between media source engine and the media element.
      if (this.mediaSourceEngine_) {
        await this.mediaSourceEngine_.destroy();
        this.mediaSourceEngine_ = null as any;
      }
      // TODO(sanfeng): AdManager
      // if (this.adManager_ && !keepAdManager) {
      //   this.adManager_.onAssetUnload();
      // }

      if (this.preloadDueAdManager_ && !keepAdManager) {
        this.preloadDueAdManager_.destroy();
        this.preloadDueAdManager_ = null;
      }

      // TODO(sanfeng): adManager
      // if (!keepAdManager) {
      //   this.preloadDueAdManagerTimer_.stop();
      // }
      // TODO(sanfeng): CmcdManager
      // if (this.cmcdManager_) {
      //   this.cmcdManager_.reset();
      // }

      // TODO(sanfeng): CmsdManager
      // if (this.cmsdManager_) {
      //   this.cmsdManager_.reset();
      // }

      if (this.video_) {
        // Remove all track nodes
        Dom.removeAllChildren(this.video_);
      }

      // In order to unload a media element, we need to remove the src attribute
      // and then load again. When we destroy media source engine, this will be
      // done for us, but for src=, we need to do it here.
      //
      // DrmEngine requires this to be done before we destroy DrmEngine itself.
      if (this.video_ && this.video_.src) {
        // TODO: Investigate this more.  Only reproduces on Firefox 69.
        // Introduce a delay before detaching the video source.  We are seeing
        // spurious Promise rejections involving an AbortError in our tests
        // otherwise.
        await new Promise((resolve) => new Timer(resolve).tickAfter(0.1));

        this.video_.removeAttribute('src');
        this.video_.load();
      }

      // if (this.drmEngine_) {
      //   await this.drmEngine_.destroy();
      //   this.drmEngine_ = null;
      // }

      if (this.preloadNextUrl_ && this.assetUri_ != this.preloadNextUrl_.getAssetUri()) {
        if (!this.preloadNextUrl_.isDestroyed()) {
          this.preloadNextUrl_.destroy();
        }
        this.preloadNextUrl_ = null;
      }

      this.assetUri_ = null;
      this.mimeType_ = null;
      this.bufferObserver_ = null as any;

      if (this.manifest_) {
        for (const variant of this.manifest_.variants) {
          for (const stream of [variant.audio, variant.video]) {
            if (stream && stream.segmentIndex) {
              stream.segmentIndex.release();
            }
          }
        }
        for (const stream of this.manifest_.textStreams) {
          if (stream.segmentIndex) {
            stream.segmentIndex.release();
          }
        }
      }

      // On some devices, cached MediaKeySystemAccess objects may corrupt
      // after several playbacks, and they are not able anymore to properly
      // create MediaKeys objects. To prevent it, clear the cache after
      // each playback.
      if (this.config_.streaming.clearDecodingCache) {
        StreamUtils.clearDecodingConfigCache();
        // TODO: DrmEngine
        // DrmEngine.clearMediaKeySystemAccessMap();
      }

      this.manifest_ = null as any;
      this.stats_ = new Stats(); // Replace with a clean object.
      this.lastTextFactory_ = null;

      this.externalSrcEqualsThumbnailsStreams_ = [];

      this.completionPercent_ = NaN;

      // Make sure that the app knows of the new buffering state.
      this.updateBufferState_();
    } catch (error) {
      console.log(error);
    }
  }

  /**
   * Update the buffering state to be either "we are buffering" or "we are not
   * buffering", firing events to the app as needed.
   *
   * @private
   */
  private updateBufferState_() {
    const isBuffering = this.isBuffering();
    log.v2('Player changing buffering state to', isBuffering);

    // Make sure we have all the components we need before we consider ourselves
    // as being loaded.
    // TODO: Make the check for "loaded" simpler.
    const loaded = this.stats_ && this.bufferObserver_ && this.playhead_;

    if (loaded) {
      this.playRateController_.setBuffering(isBuffering);
      // if (this.cmcdManager_) {
      //   this.cmcdManager_.setBuffering(isBuffering);
      // }
      this.updateStateHistory_();
    }

    // Surface the buffering event so that the app knows if/when we are
    // buffering.
    const eventName = FakeEvent.EventName.Buffering;
    const data = new Map().set('buffering', isBuffering);
    this.dispatchEvent(Player.makeEvent_(eventName, data));
  }

  /**
   * Try updating the state history. If the player has not finished
   * initializing, this will be a no-op.
   *
   */
  private updateStateHistory_() {
    // If we have not finish initializing, this will be a no-op.
    if (!this.stats_) {
      return;
    }
    if (!this.bufferObserver_) {
      return;
    }

    const history = this.stats_.getStateHistory();

    let updateState = 'playing';
    if (this.bufferObserver_.getState() === BufferingObserverState.STARVING) {
      updateState = 'buffering';
    } else if (this.video_.paused) {
      updateState = 'paused';
    } else if (this.video_.ended) {
      updateState = 'ended';
    }
    const stateChanged = history.update(updateState);

    if (stateChanged) {
      const eventName = FakeEvent.EventName.StateChanged;
      const data = new Map().set('newstate', updateState);
      this.dispatchEvent(Player.makeEvent_(eventName, data));
    }
  }
  /**
   * Check if the player is currently in a buffering state (has too little
   * content to play smoothly). If the player has not loaded content, this will
   * return <code>false</code>.
   *
   * @export
   */
  isBuffering() {
    return this.bufferObserver_ ? this.bufferObserver_.getState() == BufferingObserverState.STARVING : false;
  }
  /**
   * TODO: support PreloadManager
   * Loads a new stream.
   * If another stream was already playing, first unloads that stream.
   *
   * @param assetUriOrPreloader
   * @param  startTime
   *    When <code>startTime</code> is <code>null</code> or
   *    <code>undefined</code>, playback will start at the default start time (0
   *    for VOD and liveEdge for LIVE).
   * @export
   */
  async load(
    assetUriOrPreloader: string | PreloadManager,
    startTime: number | null = null,
    mimeType: string | null = null
  ) {
    // Do not allow the player to be used after |destroy| is called.
    if (this.loadMode_ === Player.LoadMode.DESTROYED) {
      throw this.createAbortLoadError_();
    }
    let preloadManager: PreloadManager | null = null;
    let assetUri = '';

    if (assetUriOrPreloader instanceof PreloadManager) {
      preloadManager = assetUriOrPreloader;
      assetUri = preloadManager.getAssetUri() || '';
    } else {
      assetUri = assetUriOrPreloader || '';
    }

    // Quickly acquire the mutex, so this will wait for other top-level
    // operations.
    await this.mutex_.acquire('load');
    this.mutex_.release();

    if (!this.video_) {
      throw new ShakaError(ShakaError.Severity.CRITICAL, ShakaError.Category.PLAYER, ShakaError.Code.NO_VIDEO_ELEMENT);
    }

    if (this.assetUri_) {
      // Note: This is used to avoid the destruction of the nextUrl
      // preloadManager that can be the current one.
      this.assetUri_ = assetUri;
      await this.unload(false);
    }

    const operationId = this.operationId_;

    // Add a mechanism to detect if the load process has been interrupted by a
    // call to another top-level operation (unload, load, etc).
    const detectInterruption = async () => {
      if (this.operationId_ !== operationId) {
        if (preloadManager) {
          await preloadManager.destroy();
        }
        throw this.createAbortLoadError_();
      }
    };

    const mutexWrapOperation = async (operation: () => Promise<any>, mutexIdentifier: string) => {
      try {
        await this.mutex_.acquire(mutexIdentifier);
        await detectInterruption();
        await operation();
        await detectInterruption();
        if (preloadManager && this.config_) {
          preloadManager.reconfigure(this.config_);
        }
      } finally {
        this.mutex_.release();
      }
    };

    try {
      if (startTime === null && preloadManager) {
        startTime = preloadManager.getStartTime();
      }

      this.startTime_ = startTime;
      this.fullyLoaded_ = false;
      // We dispatch the loading event when someone calls |load| because we want
      // to surface the user intent.
      this.dispatchEvent(Player.makeEvent_(FakeEvent.EventName.Loading));

      if (preloadManager) {
        mimeType = preloadManager.getMimeType();
      } else if (!mimeType) {
        await mutexWrapOperation(async () => {
          mimeType = await this.guessMimeType_(assetUri);
        }, 'guessMimeType_');
      }
      const wasPreloaded = !!preloadManager;

      if (!preloadManager) {
        // For simplicity, if an asset is NOT preloaded, start an internal
        // "preload" here without prefetch.
        // That way, both a preload and normal load can follow the same code
        // paths.
        // NOTE: await preloadInner_ can be outside the mutex because it should
        // not mutate "this".

        preloadManager = await this.preloadInner_(assetUri, startTime, mimeType, true);

        if (preloadManager) {
          preloadManager.setEventHandoffTarget(this);
          this.stats_ = preloadManager.getStats();
          preloadManager.start();
          // Silence "uncaught error" warnings from this. Unless we are
          // interrupted, we will check the result of this process and respond
          // appropriately. If we are interrupted, we can ignore any error
          // there.
          preloadManager.waitForFinish().catch(() => {});
        } else {
          this.stats_ = new Stats();
        }
      } else {
        // Hook up events, so any events emitted by the preloadManager will
        // instead be emitted by the player.
        preloadManager.setEventHandoffTarget(this);
        this.stats_ = preloadManager.getStats();
      }

      // Now, if there is no preload manager, that means that this is a src=
      // asset.

      const startTimeOfLoad = preloadManager ? preloadManager.getStartTimeOfLoad() : Date.now() / 1000;

      // Stats are for a single playback/load session. Stats must be initialized
      // before we allow calls to |updateStateHistory|.
      this.stats_ = preloadManager ? preloadManager.getStats() : new Stats();

      this.assetUri_ = assetUri;
      this.mimeType_ = mimeType || null;

      if (!preloadManager) {
        // TODO(sanfeng): DRMEngine
        // await mutexWrapOperation(async () => {}, 'initializeSrcEqualsDrmInner_');

        await mutexWrapOperation(async () => {
          asserts.assert(mimeType, 'We should know the mimeType by now!');

          await this.srcEqualsInner_(startTimeOfLoad, mimeType!);
        }, 'srcEqualsInner_');
      } else {
        if (!this.mediaSourceEngine_) {
          await mutexWrapOperation(async () => {
            await this.initializeMediaSourceEngineInner_();
          }, 'initializeMediaSourceEngineInner_');
        }

        // Wait for the preload manager to do all of the loading it can do.
        await mutexWrapOperation(async () => {
          await preloadManager!.waitForFinish();
        }, 'waitForFinish');

        // Get manifest and associated values from preloader

        this.config_ = preloadManager.getConfiguration();
        this.manifestFilterer_ = preloadManager.getManifestFilterer();
        this.manifest_ = preloadManager.getManifest()!;
        this.parserFactory_ = preloadManager.getParserFactory()!;
        this.parser_ = preloadManager.receiveParser()!;
        this.regionTimeline_ = preloadManager.getRegionTimeline();
        this.qualityObserver_ = preloadManager.getQualityObserver()!;

        const currentAdaptationSetCriteria = preloadManager.getCurrentAdaptationSetCriteria();

        if (currentAdaptationSetCriteria) {
          this.currentAdaptationSetCriteria_ = currentAdaptationSetCriteria;
        }

        if (wasPreloaded && this.video_ && this.video_.nodeName.toLocaleLowerCase() === 'audio') {
          // Filter the variants to be audio-only after the fact.
          // As, when preloading, we don't know if we are going to be attached
          // to a video or audio element when we load, we have to do the auto
          // audio-only filtering here, post-facto.
          this.makeManifestAudioOnly_();
          // And continue to do so in the future.
          this.configure('manifest.disableVideo', true);
        }

        // TODO: DrmEngine

        // Also get the ABR manager, which has special logic related to being
        // received.
        const abrManagerFactory = preloadManager.getAbrManagerFactory();
        if (abrManagerFactory) {
          if (!this.abrManagerFactory_ || this.abrManagerFactory_ !== abrManagerFactory) {
            this.abrManager_ = preloadManager.receiveAbrManager();
            this.abrManagerFactory_ = preloadManager.getAbrManagerFactory()!;
            if (typeof this.abrManager_.setMediaElement != 'function') {
              Deprecate.deprecateFeature(
                5,
                'AbrManager w/o setMediaElement',
                'Please use an AbrManager with setMediaElement function.'
              );
              this.abrManager_.setMediaElement = () => {};
            }
            if (typeof this.abrManager_.setCmsdManager != 'function') {
              Deprecate.deprecateFeature(
                5,
                'AbrManager w/o setCmsdManager',
                'Please use an AbrManager with setCmsdManager function.'
              );
              this.abrManager_.setCmsdManager = () => {};
            }
            if (typeof this.abrManager_.trySuggestStreams != 'function') {
              Deprecate.deprecateFeature(
                5,
                'AbrManager w/o trySuggestStreams',
                'Please use an AbrManager with trySuggestStreams function.'
              );
              this.abrManager_.trySuggestStreams = () => {};
            }
          }
        }

        // Load the asset.
        const segmentPrefetchById = preloadManager.receiveSegmentPrefetchesById();
        const prefetchedVariant = preloadManager.getPrefetchedVariant();
        await mutexWrapOperation(async () => {
          await this.loadInner_(startTimeOfLoad, prefetchedVariant, segmentPrefetchById);
        }, 'loadInner_');
        preloadManager.stopQueuingLatePhaseQueuedOperations();
      }

      this.dispatchEvent(Player.makeEvent_(FakeEvent.EventName.Loaded));
    } catch (error: any) {
      if (error.code === ShakaError.Code.LOAD_INTERRUPTED) {
        await this.unload(false);
      }
      throw error;
    } finally {
      if (preloadManager) {
        // This will cause any resources that were generated but not used to be
        // properly destroyed or released.
        await preloadManager.destroy();
      }
      this.preloadNextUrl_ = null;
    }
  }

  /**
   * Modifies the current manifest so that it is audio-only.
   */
  private makeManifestAudioOnly_() {
    for (const variant of this.manifest_.variants) {
      if (variant.video) {
        variant.video.closeSegmentIndex?.();
        variant.video = null;
      }

      if (variant.audio && variant.audio.bandwidth) {
        variant.bandwidth = variant.audio.bandwidth;
      } else {
        variant.bandwidth = 0;
      }
    }
    this.manifest_.variants.filter((v) => v.audio);
  }

  /**
   * Starts loading the content described by the parsed manifest.
   * @param startTimeOfLoad
   * @param prefetchedVariant
   * @param segmentPrefetchById
   */
  private async loadInner_(
    startTimeOfLoad: number,
    prefetchedVariant: Variant | null,
    segmentPrefetchById: Map<number, SegmentPrefetch>
  ) {
    asserts.assert(this.video_, 'We should have a media element by now.');
    asserts.assert(this.manifest_, 'The manifest should already be parsed.');
    asserts.assert(this.assetUri_, 'We should have an asset uri by now.');
    asserts.assert(this.abrManager_, 'We should have an abr manager by now.');

    this.makeStateChangeEvent_('load');
    const mediaElement = this.video_;

    this.playRateController_ = new PlayRateController({
      getDefaultRate: () => {
        return mediaElement.defaultPlaybackRate;
      },
      getRate: () => mediaElement.playbackRate,
      setRate: (rate) => {
        mediaElement.playbackRate = rate;
      },
      movePlayhead: (delta) => (mediaElement.currentTime += delta),
    });

    const updateStateHistory = () => this.updateStateHistory_();
    const onRateChange = () => this.onRateChange_();
    this.loadEventManager_.listen(mediaElement, 'play', updateStateHistory);
    this.loadEventManager_.listen(mediaElement, 'pause', updateStateHistory);
    this.loadEventManager_.listen(mediaElement, 'ended', updateStateHistory);
    this.loadEventManager_.listen(mediaElement, 'ratechange', onRateChange);

    this.currentTextLanguage_ = this.config_.preferredTextLanguage;
    this.currentTextRole_ = this.config_.preferredTextRole;
    this.currentTextForced_ = this.config_.preferForcedSubs;
    Player.applyPlayRange_(this.manifest_.presentationTimeline, this.config_.playRangeStart, this.config_.playRangeEnd);
    this.abrManager_.init((variant, clearBuffer, safeMargin) => {
      return this.switch_(variant, clearBuffer, safeMargin);
    });

    this.abrManager_.setMediaElement(mediaElement);

    // TODO: CmsdManager
    // this.abrManager_.setCmsdManager(this.cmsdManager_);

    this.streamingEngine_ = this.createStreamingEngine();
    this.streamingEngine_.configure(this.config_.streaming);

    // Set the load mode to "loaded with media source" as late as possible so
    // that public methods won't try to access internal components until
    // they're all initialized. We MUST switch to loaded before calling
    // "streaming" so that they can access internal information.
    this.loadMode_ = Player.LoadMode.MEDIA_SOURCE;

    if (mediaElement.textTracks) {
      this.loadEventManager_.listen(mediaElement.textTracks, 'addtrack', (e) => {
        const trackEvent = e as TrackEvent;
        if (trackEvent.track) {
          const track = trackEvent.track;
          asserts.assert(track instanceof TextTrack, 'Wrong track type!');

          switch (track.kind) {
            case 'chapters':
              this.activateChaptersTrack_(track);
              break;
          }
        }
      });
    }

    // The event must be fired after we filter by restrictions but before the
    // active stream is picked to allow those listening for the "streaming"
    // event to make changes before streaming starts.
    this.dispatchEvent(Player.makeEvent_(FakeEvent.EventName.Streaming));

    // Pick the initial streams to play.
    // Unless the user has already picked a variant, anyway, by calling
    // selectVariantTrack before this loading stage.
    let initialVariant = prefetchedVariant;
    let toLazyLoad: Variant;
    let activeVariant;
    do {
      activeVariant = this.streamingEngine_.getCurrentVariant();
      if (!activeVariant && !initialVariant) {
        initialVariant = this.chooseVariant_(/* initialSelection= */ true);
        asserts.assert(initialVariant, 'Must choose an initial variant!');
      }

      // Lazy-load the stream, so we will have enough info to make the playhead.
      const createSegmentIndexPromises = [];
      toLazyLoad = activeVariant || initialVariant!;
      for (const stream of [toLazyLoad.video, toLazyLoad.audio]) {
        if (stream && !stream.segmentIndex) {
          createSegmentIndexPromises.push(stream.createSegmentIndex());
        }
      }
      if (createSegmentIndexPromises.length > 0) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.all(createSegmentIndexPromises);
      }
    } while (!toLazyLoad || toLazyLoad.disabledUntilTime != 0);

    if (this.parser_ && this.parser_.onInitialVariantChosen) {
      this.parser_.onInitialVariantChosen(toLazyLoad);
    }

    // if (this.manifest_.isLowLatency && !this.config_.streaming.lowLatencyMode) {
    //   log.alwaysWarn(
    //     'Low-latency live stream detected, but ' +
    //       'low-latency streaming mode is not enabled in Shaka Player. ' +
    //       'Set streaming.lowLatencyMode configuration to true, and see ' +
    //       'https://bit.ly/3clctcj for details.'
    //   );
    // }

    Player.applyPlayRange_(this.manifest_.presentationTimeline, this.config_.playRangeStart, this.config_.playRangeEnd);

    const setupPlayhead = (startTime: number) => {
      this.playhead_ = this.createPlayhead(startTime);
      this.playheadObservers_ = this.createPlayheadObserversForMSE_(startTime);

      // We need to start the buffer management code near the end because it
      // will set the initial buffering state and that depends on other
      // components being initialized.
      const rebufferThreshold = Math.max(this.manifest_.minBufferTime, this.config_.streaming.rebufferingGoal);
      this.startBufferManagement_(mediaElement, rebufferThreshold);
    };

    if (!this.config_.streaming.startAtSegmentBoundary) {
      setupPlayhead(this.startTime_!);
    }

    // Now we can switch to the initial variant.
    if (!activeVariant) {
      asserts.assert(initialVariant, 'Must have choosen an initial variant!');

      // Now that we have initial streams, we may adjust the start time to
      // align to a segment boundary.
      if (this.config_.streaming.startAtSegmentBoundary) {
        const timeline = this.manifest_.presentationTimeline;
        let initialTime = this.startTime_ || this.video_.currentTime;
        const seekRangeStart = timeline.getSeekRangeStart();
        const seekRangeEnd = timeline.getSeekRangeEnd();
        if (initialTime < seekRangeStart) {
          initialTime = seekRangeStart;
        } else if (initialTime > seekRangeEnd) {
          initialTime = seekRangeEnd;
        }
        const startTime = await this.adjustStartTime_(initialVariant!, initialTime);
        setupPlayhead(startTime);
      }

      this.switchVariant_(initialVariant!, /* fromAdaptation= */ true, /* clearBuffer= */ false, /* safeMargin= */ 0);
    }

    this.playhead_.ready();

    // Decide if text should be shown automatically.
    // similar to video/audio track, we would skip switch initial text track
    // if user already pick text track (via selectTextTrack api)
    // TODO(sanfeng): TextStream
    // const activeTextTrack = this.getTextTracks().find((t) => t.active);

    // if (!activeTextTrack) {
    //   const initialTextStream = this.chooseTextStream_();

    //   if (initialTextStream) {
    //     this.addTextStreamToSwitchHistory_(initialTextStream, /* fromAdaptation= */ true);
    //   }

    //   if (initialVariant) {
    //     this.setInitialTextState_(initialVariant, initialTextStream);
    //   }

    //   // Don't initialize with a text stream unless we should be streaming
    //   // text.
    //   if (initialTextStream && this.shouldStreamText_()) {
    //     this.streamingEngine_.switchTextStream(initialTextStream);
    //   }
    // }

    // Start streaming content. This will start the flow of content down to
    // media source.
    await this.streamingEngine_.start(segmentPrefetchById);

    if (this.config_.abr.enabled) {
      this.abrManager_.enable();
      this.onAbrStatusChanged_();
    }

    // Dispatch a 'trackschanged' event now that all initial filtering is
    // done.
    this.onTracksChanged_();

    // Now that we've filtered out variants that aren't compatible with the
    // active one, update abr manager with filtered variants.
    // NOTE: This may be unnecessary.  We've already chosen one codec in
    // chooseCodecsAndFilterManifest_ before we started streaming.  But it
    // doesn't hurt, and this will all change when we start using
    // MediaCapabilities and codec switching.
    // TODO(#1391): Re-evaluate with MediaCapabilities and codec switching.
    this.updateAbrManagerVariants_();

    const hasPrimary = this.manifest_.variants.some((v) => v.primary);
    if (!this.config_.preferredAudioLanguage && !hasPrimary) {
      log.warning('No preferred audio language set.  ' + 'We have chosen an arbitrary language initially');
    }
    const isLive = this.isLive();
    if (
      (isLive &&
        (this.config_.streaming.liveSync.enabled ||
          this.manifest_.serviceDescription ||
          this.config_.streaming.liveSync.panicMode)) ||
      this.config_.streaming.vodDynamicPlaybackRate
    ) {
      const onTimeUpdate = () => this.onTimeUpdate_();
      this.loadEventManager_.listen(mediaElement, 'timeupdate', onTimeUpdate);
    }

    if (!isLive) {
      const onVideoProgress = () => this.onVideoProgress_();
      this.loadEventManager_.listen(mediaElement, 'timeupdate', onVideoProgress);
      this.onVideoProgress_();

      if (this.manifest_.nextUrl) {
        if (this.config_.streaming.preloadNextUrlWindow > 0) {
          const onTimeUpdate = async () => {
            const timeToEnd = this.video_.duration - this.video_.currentTime;
            if (!isNaN(timeToEnd)) {
              if (timeToEnd <= this.config_.streaming.preloadNextUrlWindow) {
                this.loadEventManager_.unlisten(mediaElement, 'timeupdate', onTimeUpdate);
                asserts.assert(this.manifest_.nextUrl, 'this.manifest_.nextUrl should be valid.');
                this.preloadNextUrl_ = await this.preload(this.manifest_.nextUrl!);
              }
            }
          };
          this.loadEventManager_.listen(mediaElement, 'timeupdate', onTimeUpdate);
        }
        this.loadEventManager_.listen(mediaElement, 'ended', () => {
          this.load(this.preloadNextUrl_ || this.manifest_.nextUrl!);
        });
      }
    }

    // TODO(sanfeng): adMananger
    // if (this.adManager_) {
    //   this.adManager_.onManifestUpdated(isLive);
    // }

    this.fullyLoaded_ = true;

    // Wait for the 'loadedmetadata' event to measure load() latency.
    this.loadEventManager_.listenOnce(mediaElement, 'loadedmetadata', () => {
      const now = Date.now() / 1000;
      const delta = now - startTimeOfLoad;
      this.stats_.setLoadLatency(delta);
    });
  }

  /**
   * Starts to preload a given asset, and returns a PreloadManager object that
   * represents that preloading process.
   * The PreloadManager will load the manifest for that asset, as well as the
   * initialization segment. It will not preload anything more than that;
   * this feature is intended for reducing start-time latency, not for fully
   * downloading assets before playing them (for that, use
   * |offline.Storage|).
   * You can pass that PreloadManager object in to the |load| method on this
   * Player instance to finish loading that particular asset, or you can call
   * the |destroy| method on the manager if the preload is no longer necessary.
   * If this returns null rather than a PreloadManager, that indicates that the
   * asset must be played with src=, which cannot be preloaded.
   *
   * @param assetUri
   * @param startTime
   *    When <code>startTime</code> is <code>null</code> or
   *    <code>undefined</code>, playback will start at the default start time (0
   *    for VOD and liveEdge for LIVE).
   * @param mimeType
   * @return
   * @export
   */
  async preload(assetUri: string, startTime: number | null = null, mimeType: string | null = null) {
    const preloadManager = await this.preloadInner_(assetUri, startTime, mimeType);
    if (!preloadManager) {
      this.onError_(
        new ShakaError(
          ShakaError.Severity.CRITICAL,
          ShakaError.Category.PLAYER,
          ShakaError.Code.SRC_EQUALS_PRELOAD_NOT_SUPPORTED
        )
      );
    } else {
      preloadManager.start();
    }
    return preloadManager;
  }

  /**
   * Callback for liveSync and vodDynamicPlaybackRate
   */
  private onTimeUpdate_() {
    const playbackRate = this.video_.playbackRate;
    const isLive = this.isLive();
    if (this.config_.streaming.vodDynamicPlaybackRate && !isLive) {
      const minPlaybackRate = this.config_.streaming.vodDynamicPlaybackRateLowBufferRate;
      const bufferFullness = this.getBufferFullness();
      const bufferThreshold = this.config_.streaming.vodDynamicPlaybackRateBufferRatio;
      if (bufferFullness <= bufferThreshold) {
        if (playbackRate != minPlaybackRate) {
          log.debug(
            'Buffer fullness ratio (' +
              bufferFullness +
              ') ' +
              'is less than the vodDynamicPlaybackRateBufferRatio (' +
              bufferThreshold +
              '). Updating playbackRate to ' +
              minPlaybackRate
          );
          this.trickPlay(minPlaybackRate);
        }
      } else if (bufferFullness == 1) {
        if (playbackRate !== this.playRateController_.getDefaultRate()) {
          log.debug('Buffer is full. Cancel trick play.');
          this.cancelTrickPlay();
        }
      }
    }
    // If the live stream has reached its end, do not sync.
    if (!isLive) {
      return;
    }

    // TODO(sanfeng): Live
    // const seekRange = this.seekRange();
    // if (!Number.isFinite(seekRange.end)) {
    //   return;
    // }
    // const currentTime = this.video_.currentTime;
    // if (currentTime < seekRange.start) {
    //   // Bad stream?
    //   return;
    // }

    // let targetLatency;
    // let maxLatency;
    // let maxPlaybackRate;
    // let minLatency;
    // let minPlaybackRate;
    // const targetLatencyTolerance = this.config_.streaming.liveSync.targetLatencyTolerance;
    // const dynamicTargetLatency = this.config_.streaming.liveSync.dynamicTargetLatency.enabled;
    // const stabilityThreshold = this.config_.streaming.liveSync.dynamicTargetLatency.stabilityThreshold;

    // if (this.config_.streaming.liveSync && this.config_.streaming.liveSync.enabled) {
    //   targetLatency = this.config_.streaming.liveSync.targetLatency;
    //   maxLatency = targetLatency + targetLatencyTolerance;
    //   minLatency = Math.max(0, targetLatency - targetLatencyTolerance);
    //   maxPlaybackRate = this.config_.streaming.liveSync.maxPlaybackRate;
    //   minPlaybackRate = this.config_.streaming.liveSync.minPlaybackRate;
    // } else {
    //   // serviceDescription must override if it is defined in the MPD and
    //   // liveSync configuration is not set.
    //   if (this.manifest_ && this.manifest_.serviceDescription) {
    //     targetLatency = this.manifest_.serviceDescription.targetLatency;
    //     if (this.manifest_.serviceDescription.targetLatency != null) {
    //       maxLatency = this.manifest_.serviceDescription.targetLatency + targetLatencyTolerance;
    //     } else if (this.manifest_.serviceDescription.maxLatency != null) {
    //       maxLatency = this.manifest_.serviceDescription.maxLatency;
    //     }
    //     if (this.manifest_.serviceDescription.targetLatency != null) {
    //       minLatency = Math.max(0, this.manifest_.serviceDescription.targetLatency - targetLatencyTolerance);
    //     } else if (this.manifest_.serviceDescription.minLatency != null) {
    //       minLatency = this.manifest_.serviceDescription.minLatency;
    //     }
    //     maxPlaybackRate =
    //       this.manifest_.serviceDescription.maxPlaybackRate || this.config_.streaming.liveSync.maxPlaybackRate;
    //     minPlaybackRate =
    //       this.manifest_.serviceDescription.minPlaybackRate || this.config_.streaming.liveSync.minPlaybackRate;
    //   }
    // }

    // if (!this.currentTargetLatency_ && typeof targetLatency === 'number') {
    //   this.currentTargetLatency_ = targetLatency;
    // }

    // const maxAttempts = this.config_.streaming.liveSync.dynamicTargetLatency.maxAttempts;
    // if (
    //   dynamicTargetLatency &&
    //   this.targetLatencyReached_ &&
    //   this.currentTargetLatency_ !== null &&
    //   typeof targetLatency === 'number' &&
    //   this.rebufferingCount_ < maxAttempts &&
    //   Date.now() - this.targetLatencyReached_ > stabilityThreshold * 1000
    // ) {
    //   const dynamicMinLatency = this.config_.streaming.liveSync.dynamicTargetLatency.minLatency;
    //   const latencyIncrement = (targetLatency - dynamicMinLatency) / 2;
    //   this.currentTargetLatency_ = Math.max(
    //     this.currentTargetLatency_ - latencyIncrement,
    //     // current target latency should be within the tolerance of the min
    //     // latency to not overshoot it
    //     dynamicMinLatency + targetLatencyTolerance
    //   );
    //   this.targetLatencyReached_ = Date.now();
    // }
    // if (dynamicTargetLatency && this.currentTargetLatency_ !== null) {
    //   maxLatency = this.currentTargetLatency_ + targetLatencyTolerance;
    //   minLatency = this.currentTargetLatency_ - targetLatencyTolerance;
    // }

    // const latency = seekRange.end - this.video_.currentTime;
    // let offset = 0;
    // // In src= mode, the seek range isn't updated frequently enough, so we need
    // // to fudge the latency number with an offset.  The playback rate is used
    // // as an offset, since that is the amount we catch up 1 second of
    // // accelerated playback.
    // if (this.loadMode_ == Player.LoadMode.SRC_EQUALS) {
    //   const buffered = this.video_.buffered;
    //   if (buffered.length > 0) {
    //     const bufferedEnd = buffered.end(buffered.length - 1);
    //     offset = Math.max(maxPlaybackRate, bufferedEnd - seekRange.end);
    //   }
    // }

    // const panicMode = this.config_.streaming.liveSync.panicMode;
    // const panicThreshold = this.config_.streaming.liveSync.panicThreshold * 1000;
    // const timeSinceLastRebuffer = Date.now() - this.bufferObserver_.getLastRebufferTime();
    // if (panicMode && !minPlaybackRate) {
    //   minPlaybackRate = this.config_.streaming.liveSync.minPlaybackRate;
    // }

    // if (panicMode && minPlaybackRate && timeSinceLastRebuffer <= panicThreshold) {
    //   if (playbackRate != minPlaybackRate) {
    //     log.debug(
    //       'Time since last rebuffer (' +
    //         timeSinceLastRebuffer +
    //         's) ' +
    //         'is less than the live sync panicThreshold (' +
    //         panicThreshold +
    //         's). Updating playbackRate to ' +
    //         minPlaybackRate
    //     );
    //     this.trickPlay(minPlaybackRate);
    //   }
    // } else if (maxLatency && maxPlaybackRate && latency - offset > maxLatency) {
    //   if (playbackRate != maxPlaybackRate) {
    //     log.debug(
    //       'Latency (' +
    //         latency +
    //         's) is greater than ' +
    //         'live sync maxLatency (' +
    //         maxLatency +
    //         's). ' +
    //         'Updating playbackRate to ' +
    //         maxPlaybackRate
    //     );
    //     this.trickPlay(maxPlaybackRate);
    //   }
    //   this.targetLatencyReached_ = null;
    // } else if (minLatency && minPlaybackRate && latency - offset < minLatency) {
    //   if (playbackRate != minPlaybackRate) {
    //     log.debug(
    //       'Latency (' +
    //         latency +
    //         's) is smaller than ' +
    //         'live sync minLatency (' +
    //         minLatency +
    //         's). ' +
    //         'Updating playbackRate to ' +
    //         minPlaybackRate
    //     );
    //     this.trickPlay(minPlaybackRate);
    //   }
    //   this.targetLatencyReached_ = null;
    // } else if (playbackRate !== this.playRateController_.getDefaultRate()) {
    //   this.cancelTrickPlay();
    //   this.targetLatencyReached_ = Date.now();
    // }
  }

  /**
   * Enable trick play to skip through content without playing by repeatedly
   * seeking. For example, a rate of 2.5 would result in 2.5 seconds of content
   * being skipped every second. A negative rate will result in moving
   * backwards.
   *
   * <p>
   * If the player has not loaded content or is still loading content this will
   * be a no-op. Wait until <code>load</code> has completed before calling.
   *
   * <p>
   * Trick play will be canceled automatically if the playhead hits the
   * beginning or end of the seekable range for the content.
   *
   * @param  rate
   * @export
   */
  trickPlay(rate: number) {
    // A playbackRate of 0 is used internally when we are in a buffering state,
    // and doesn't make sense for trick play.  If you set a rate of 0 for trick
    // play, we will reject it and issue a warning.  If it happens during a
    // test, we will fail the test through this assertion.
    asserts.assert(rate != 0, 'Should never set a trick play rate of 0!');
    if (rate == 0) {
      log.alwaysWarn('A trick play rate of 0 is unsupported!');
      return;
    }
    this.trickPlayEventManager_.removeAll();

    if (this.video_.paused) {
      // Our fast forward is implemented with playbackRate and needs the video
      // to be playing (to not be paused) to take immediate effect.
      // If the video is paused, "unpause" it.
      this.video_.play();
    }
    this.playRateController_.set(rate);

    if (this.loadMode_ == Player.LoadMode.MEDIA_SOURCE) {
      this.abrManager_.playbackRateChanged(rate);
      this.streamingEngine_.setTrickPlay(Math.abs(rate) > 1);
    }
    if (this.isLive()) {
      this.trickPlayEventManager_.listen(this.video_, 'timeupdate', () => {
        const currentTime = this.video_.currentTime;
        const seekRange = this.seekRange();
        const safeSeekOffset = this.config_.streaming.safeSeekOffset;

        // Cancel trick play if we hit the beginning or end of the seekable
        // (Sub-second accuracy not required here)
        if (rate > 0) {
          if (Math.floor(currentTime) >= Math.floor(seekRange.end)) {
            this.cancelTrickPlay();
          }
        } else {
          if (Math.floor(currentTime) <= Math.floor(seekRange.start + safeSeekOffset)) {
            this.cancelTrickPlay();
          }
        }
      });
    }
  }

  /**
   * Cancel trick-play. If the player has not loaded content or is still loading
   * content this will be a no-op.
   *
   * @export
   */
  cancelTrickPlay() {
    const defaultPlaybackRate = this.playRateController_.getDefaultRate();
    if (this.loadMode_ == Player.LoadMode.SRC_EQUALS) {
      this.playRateController_.set(defaultPlaybackRate);
    }

    if (this.loadMode_ == Player.LoadMode.MEDIA_SOURCE) {
      this.playRateController_.set(defaultPlaybackRate);
      this.abrManager_.playbackRateChanged(defaultPlaybackRate);
      this.streamingEngine_.setTrickPlay(false);
    }
    this.trickPlayEventManager_.removeAll();
  }

  /**
   * Returns the ratio of video length buffered compared to buffering Goal
   */
  getBufferFullness() {
    if (this.video_) {
      const bufferedLength = this.video_.buffered.length;
      const bufferedEnd = bufferedLength > 0 ? this.video_.buffered.end(bufferedLength - 1) : 0;
      const bufferingGoal = this.getConfiguration().streaming.bufferingGoal;
      const lengthToBeBuffered = Math.min(this.video_.currentTime + bufferingGoal, this.seekRange().end);
      if (bufferedEnd >= lengthToBeBuffered) {
        return 1;
      } else if (bufferedEnd <= this.video_.currentTime) {
        return 0;
      } else if (bufferedEnd < lengthToBeBuffered) {
        return (bufferedEnd - this.video_.currentTime) / (lengthToBeBuffered - this.video_.currentTime);
      }
    }

    return 0;
  }

  /**
   * Return a copy of the current configuration.  Modifications of the returned
   * value will not affect the Player's active configuration.  You must call
   * <code>player.configure()</code> to make changes.
   *
   * @return {extern.PlayerConfiguration}
   * @export
   */
  getConfiguration() {
    asserts.assert(this.config_, 'Config must not be null!');

    const ret = this.defaultConfig_();
    PlayerConfiguration.mergeConfigObjects(ret, this.config_, this.defaultConfig_());
    return ret;
  }

  /**
   * Callback from AbrManager.
   *
   * @param {extern.Variant} variant
   * @param {boolean=} clearBuffer
   * @param {number=} safeMargin Optional amount of buffer (in seconds) to
   *   retain when clearing the buffer.
   *   Defaults to 0 if not provided. Ignored if clearBuffer is false.
   * @private
   */
  private switch_(variant: Variant, clearBuffer = false, safeMargin = 0) {
    log.debug('switch_');
    asserts.assert(this.config_.abr.enabled, 'AbrManager should not call switch while disabled!');

    if (!this.manifest_) {
      // It could come from a preload manager operation.
      return;
    }

    if (!this.streamingEngine_) {
      // There's no way to change it.
      return;
    }

    if (variant == this.streamingEngine_.getCurrentVariant()) {
      // This isn't a change.
      return;
    }

    this.switchVariant_(variant, /* fromAdaptation= */ true, clearBuffer, safeMargin);
  }

  /**
   * @param initialVariant
   * @param time
   * @return
   */
  private async adjustStartTime_(initialVariant: Variant, time: number) {
    const activeAudio = initialVariant.audio;

    const activeVideo = initialVariant.video;

    const getAdjustedTime = async (stream: Stream | null, time: number) => {
      if (!stream) {
        return null;
      }

      await stream.createSegmentIndex();
      const iter = stream.segmentIndex!.getIteratorForTime(time);
      const ref = iter ? iter.next().value : null;
      if (!ref) {
        return null;
      }

      const refTime = ref.startTime;
      asserts.assert(refTime <= time, 'Segment should start before target time!');
      return refTime;
    };

    const audioStartTime = await getAdjustedTime(activeAudio, time);
    const videoStartTime = await getAdjustedTime(activeVideo, time);

    // If we have both video and audio times, pick the larger one.  If we picked
    // the smaller one, that one will download an entire segment to buffer the
    // difference.
    if (videoStartTime != null && audioStartTime != null) {
      return Math.max(videoStartTime, audioStartTime);
    } else if (videoStartTime != null) {
      return videoStartTime;
    } else if (audioStartTime != null) {
      return audioStartTime;
    } else {
      return time;
    }
  }

  /**
   * Callback for video progress events
   *
   * @private
   */
  private onVideoProgress_() {
    if (!this.video_) {
      return;
    }
    let hasNewCompletionPercent = false;
    const completionRatio = this.video_.currentTime / this.video_.duration;
    if (!isNaN(completionRatio)) {
      const percent = Math.round(100 * completionRatio);
      if (isNaN(this.completionPercent_)) {
        this.completionPercent_ = percent;
        hasNewCompletionPercent = true;
      } else {
        const newCompletionPercent = Math.max(this.completionPercent_, percent);
        if (this.completionPercent_ != newCompletionPercent) {
          this.completionPercent_ = newCompletionPercent;
          hasNewCompletionPercent = true;
        }
      }
    }
    if (hasNewCompletionPercent) {
      let event;
      if (this.completionPercent_ == 0) {
        event = Player.makeEvent_(FakeEvent.EventName.Started);
      } else if (this.completionPercent_ == 25) {
        event = Player.makeEvent_(FakeEvent.EventName.FirstQuartile);
      } else if (this.completionPercent_ == 50) {
        event = Player.makeEvent_(FakeEvent.EventName.Midpoint);
      } else if (this.completionPercent_ == 75) {
        event = Player.makeEvent_(FakeEvent.EventName.ThirdQuartile);
      } else if (this.completionPercent_ == 100) {
        event = Player.makeEvent_(FakeEvent.EventName.Complete);
      }
      if (event) {
        this.dispatchEvent(event);
      }
    }
  }

  private onAbrStatusChanged_() {
    // Restore disabled variants if abr get disabled
    if (!this.config_.abr.enabled) {
      this.restoreDisabledVariants_();
    }

    const data = new Map().set('newStatus', this.config_.abr.enabled);
    this.delayDispatchEvent_(Player.makeEvent_(FakeEvent.EventName.AbrStatusChanged, data));
  }

  private switchVariant_(
    variant: Variant,
    fromAdaptation: boolean,
    clearBuffer: boolean,
    safeMargin: number,
    force = false
  ) {
    const currentVariant = this.streamingEngine_.getCurrentVariant();
    if (variant === currentVariant) {
      log.debug('Variant already selected.');
      // If you want to clear the buffer, we force to reselect the same variant.
      // We don't need to reset the timestampOffset since it's the same variant,
      // so 'adaptation' isn't passed here.
      if (clearBuffer) {
        this.streamingEngine_.switchVariant(variant, clearBuffer, safeMargin, /* force= */ true);
      }
      return;
    }

    // Add entries to the history.
    this.addVariantToSwitchHistory_(variant, fromAdaptation);
    this.streamingEngine_.switchVariant(variant, clearBuffer, safeMargin, force, /* adaptation= */ fromAdaptation);
    let oldTrack: Track | null = null;
    if (currentVariant) {
      oldTrack = StreamUtils.variantToTrack(currentVariant);
    }
    const newTrack = StreamUtils.variantToTrack(variant);

    if (fromAdaptation) {
      // Dispatch an 'adaptation' event
      this.onAdaptation_(oldTrack, newTrack);
    } else {
      // Dispatch a 'variantchanged' event
      this.onVariantChanged_(oldTrack, newTrack);
    }
  }

  private addVariantToSwitchHistory_(variant: Variant, fromAdaptation: boolean) {
    const switchHistory = this.stats_.getSwitchHistory();
    switchHistory.updateCurrentVariant(variant, fromAdaptation);
  }

  /**
   * Dispatches an 'adaptation' event.
   * @param from
   * @param to
   */
  private onAdaptation_(from: Track | null, to: Track) {
    // Delay the 'adaptation' event so that StreamingEngine has time to absorb
    // the changes before the user tries to query it.
    const data = new Map().set('oldTrack', from).set('newTrack', to);

    const event = Player.makeEvent_(FakeEvent.EventName.Adaptation, data);
    this.delayDispatchEvent_(event);
  }

  /**
   * Dispatches a 'variantchanged' event.
   * @param from
   * @param to
   */
  private onVariantChanged_(from: Track | null, to: Track) {
    // Delay the 'variantchanged' event so StreamingEngine has time to absorb
    // the changes before the user tries to query it.
    const data = new Map().set('oldTrack', from).set('newTrack', to);

    const event = Player.makeEvent_(FakeEvent.EventName.VariantChanged, data);
    this.delayDispatchEvent_(event);
  }

  /**
   * Create the observers for MSE playback. These observers are responsible for
   * notifying the app and player of specific events during MSE playback.
   */
  private createPlayheadObserversForMSE_(startTime: number) {
    asserts.assert(this.manifest_, 'Must have manifest');
    asserts.assert(this.regionTimeline_, 'Must have region timeline');
    asserts.assert(this.video_, 'Must have video element');

    const startsPastZero = this.isLive() || startTime > 0;

    // Create the region observer. This will allow us to notify the app when we
    // move in and out of timeline regions.
    const regionObserver = new RegionObserver(this.regionTimeline_, startsPastZero);
    regionObserver.addEventListener('enter', (event: any) => {
      const region = event['region'];
      this.onRegionEvent_(FakeEvent.EventName.TimelineRegionEnter, region);
    });

    regionObserver.addEventListener('exit', (event: any) => {
      const region = event['region'];
      this.onRegionEvent_(FakeEvent.EventName.TimelineRegionExit, region);
    });

    regionObserver.addEventListener('skip', (event: any) => {
      const region = event['region'];

      const seeking = event['seeking'];
      // If we are seeking, we don't want to surface the enter/exit events since
      // they didn't play through them.
      if (!seeking) {
        this.onRegionEvent_(FakeEvent.EventName.TimelineRegionEnter, region);
        this.onRegionEvent_(FakeEvent.EventName.TimelineRegionExit, region);
      }
    });

    // Now that we have all our observers, create a manager for them.
    const manager = new PlayheadObserverManager(this.video_);
    manager.manage(regionObserver);
    if (this.qualityObserver_) {
      manager.manage(this.qualityObserver_);
    }
    return manager;
  }

  /**
   * Creates a new instance of Playhead.  This can be replaced by tests to
   * create fake instances instead.
   *
   * @param startTime
   * @return
   */
  createPlayhead(startTime: number) {
    asserts.assert(this.manifest_, 'Must have manifest');
    asserts.assert(this.video_, 'Must have video');
    return new MediaSourcePlayhead(
      this.video_,
      this.manifest_,
      this.config_.streaming,
      startTime,
      () => this.onSeek_(),
      (event) => this.dispatchEvent(event)
    );
  }

  /**
   * Callback from Playhead.
   */
  private onSeek_() {
    if (this.playheadObservers_) {
      this.playheadObservers_.notifyOfSeek();
    }
    if (this.streamingEngine_) {
      this.streamingEngine_.seeked();
    }
    if (this.bufferObserver_) {
      // If we seek into an unbuffered range, we should fire a 'buffering' event
      // immediately.  If StreamingEngine can buffer fast enough, we may not
      // update our buffering tracking otherwise.
      this.pollBufferState_();
    }
  }

  /**
   * Chooses a variant from all possible variants while taking into account
   * restrictions, preferences, and ABR.
   *
   * On error, this dispatches an error event and returns null.
   * @param initialSelection
   */
  private chooseVariant_(initialSelection = false) {
    if (this.updateAbrManagerVariants_()) {
      return this.abrManager_.chooseVariant(initialSelection);
    } else {
      return null;
    }
  }

  /**
   * Update AbrManager with variants while taking into account restrictions,
   * preferences, and ABR.
   *
   * On error, this dispatches an error event and returns false.
   *
   * @return  True if successful.
   */
  private updateAbrManagerVariants_() {
    try {
      asserts.assert(this.manifest_, 'Manifest should exist by now!');
      this.manifestFilterer_.checkRestrictedVariants(this.manifest_);
    } catch (error: any) {
      this.onError_(error);
      return false;
    }
    const playableVariants = StreamUtils.getPlayableVariants(this.manifest_.variants);

    // Update the abr manager with newly filtered variants.
    const adaptationSet = this.currentAdaptationSetCriteria_.create(playableVariants);
    this.abrManager_.setVariants(Array.from(adaptationSet.values()));
    return true;
  }

  /**
   * Creates a new instance of StreamingEngine.  This can be replaced by tests
   * to create fake instances instead.
   */
  createStreamingEngine() {
    asserts.assert(this.abrManager_ && this.mediaSourceEngine_ && this.manifest_, 'Must not be destroyed');
    const playerInterface: StreamingEnginePlayerInterface = {
      getPresentationTime: () => (this.playhead_ ? this.playhead_.getTime() : 0),
      getBandwidthEstimate: () => this.abrManager_.getBandwidthEstimate(),
      getPlaybackRate: () => this.getPlaybackRate(),
      mediaSourceEngine: this.mediaSourceEngine_,
      netEngine: this.networkingEngine_,
      onError: (error) => this.onError_(error),
      onEvent: (event) => this.dispatchEvent(event),
      onManifestUpdate: () => this.onManifestUpdate_(),
      onSegmentAppended: (reference, stream) => {
        this.onSegmentAppended_(reference.startTime, reference.endTime, stream.type, stream.codecs.includes(','));
        if (this.abrManager_ && stream.fastSwitching && reference.isPartial() && reference.isLastPartial()) {
          this.abrManager_.trySuggestStreams();
        }
      },
      onInitSegmentAppended: (position, initSegment) => {
        const mediaQuality = initSegment.getMediaQuality();
        if (mediaQuality && this.qualityObserver_) {
          this.qualityObserver_.addMediaQualityChange(mediaQuality, position);
        }
      },
      beforeAppendSegment: (contentType, segment): Promise<void> => {
        // TODO(sanfeng): DrmEngine
        // return this.drmEngine_.parseInbandPssh(contentType, segment);
        return Promise.resolve();
      },
      onMetadata: (metadata, offset, endTime) => {
        this.processTimedMetadataMediaSrc_(metadata, offset, endTime);
      },
      disableStream: (stream, time) => this.disableStream(stream, time),
    };

    return new StreamingEngine(this.manifest_, playerInterface);
  }

  /**
   * Callback from StreamingEngine.
   *
   * @param start
   * @param end
   * @param contentType
   * @param isMuxed
   *
   */
  private onSegmentAppended_(start: number, end: number, contentType: string, isMuxed: boolean) {
    // When we append a segment to media source (via streaming engine) we are
    // changing what data we have buffered, so notify the playhead of the
    // change.
    if (this.playhead_) {
      this.playhead_.notifyOfBufferingChange();
      // Skip the initial buffer gap
      const startTime = this.mediaSourceEngine_.bufferStart(contentType);
      if (
        !this.isLive() &&
        // If not paused then GapJumpingController will handle this gap.
        this.video_.paused &&
        startTime != null &&
        startTime > 0 &&
        this.playhead_.getTime() < startTime
      ) {
        this.playhead_.setStartTime(startTime);
      }
    }
    this.pollBufferState_();

    // Dispatch an event for users to consume, too.
    const data = new Map().set('start', start).set('end', end).set('contentType', contentType).set('isMuxed', isMuxed);
    this.dispatchEvent(Player.makeEvent_(FakeEvent.EventName.SegmentAppended, data));
  }

  /**
   * Callback from StreamingEngine.
   *
   */
  private onManifestUpdate_() {
    if (this.parser_ && this.parser_.update) {
      this.parser_.update();
    }
  }

  /**
   * Get the playback rate of what is playing right now. If we are using trick
   * play, this will return the trick play rate.
   * If no content is playing, this will return 0.
   * If content is buffering, this will return the expected playback rate once
   * the video starts playing.
   *
   * <p>
   * If the player has not loaded content, this will return a playback rate of
   * 0.
   *
   * @returns
   */
  getPlaybackRate() {
    if (!this.video_) {
      return 0;
    }
    return this.playRateController_ ? this.playRateController_.getRealRate() : 1;
  }

  /**
   * Provides a way to update the stream start position during the media loading
   * process. Can for example be called from the <code>manifestparsed</code>
   * event handler to update the start position based on information in the
   * manifest.
   */
  updateStartTime(startTime: number) {
    this.startTime_ = startTime;
  }

  /**
   * Unloads the currently playing stream, if any, and returns a PreloadManager
   * that contains the loaded manifest of that asset, if any.
   * Allows for the asset to be re-loaded by this player faster, in the future.
   * When in src= mode, this unloads but does not make a PreloadManager.
   *
   * @param initializeMediaSource
   * @param keepAdManager
   */
  async unloadAndSavePreload(initializeMediaSource = true, keepAdManager = false): Promise<PreloadManager | null> {
    const preloadManager = await this.savePreload_();
    await this.unload(initializeMediaSource, keepAdManager);
    return preloadManager;
  }

  /**
   * Detach the player from the current media element, if any, and returns a
   * PreloadManager that contains the loaded manifest of that asset, if any.
   * Allows for the asset to be re-loaded by this player faster, in the future.
   * When in src= mode, this detach but does not make a PreloadManager.
   * Leaves the player in a state where it cannot play media, until it has been
   * attached to something else.
   *
   * @param keepAdManager
   * @param saveLivePosition
   */
  async detachAndSavePreload(keepAdManager = false, saveLivePosition = false): Promise<PreloadManager | null> {
    const preloadManager = await this.savePreload_(saveLivePosition);
    await this.detach(keepAdManager);
    return preloadManager;
  }

  async savePreload_(saveLivePosition = false) {
    let preloadManager = null;
    if (this.manifest_ && this.parser_ && this.parserFactory_ && this.assetUri_) {
      let startTime = this.video_.currentTime;
      if (this.isLive() && !saveLivePosition) {
        startTime = null as any;
      }
      // We have enough information to make a PreloadManager!
      const startTimeOfLoad = Date.now() / 1000;
      preloadManager = await this.makePreloadManager_(
        this.assetUri_,
        startTime,
        this.mimeType_,
        startTimeOfLoad,
        /* allowPrefetch= */ true,
        /* disableVideo= */ false,
        /* allowMakeAbrManager= */ false
      );
      this.createdPreloadManagers_.push(preloadManager);
      preloadManager.attachManifest(this.manifest_, this.parser_, this.parserFactory_);
      preloadManager.attachAbrManager(this.abrManager_, this.abrManagerFactory_);
      preloadManager.attachAdaptationSetCriteria(this.currentAdaptationSetCriteria_);
      preloadManager.start();
      // Null the manifest and manifestParser, so that they won't be shut down
      // during unload and will continue to live inside the preloadManager.
      this.manifest_ = null as any;
      this.parser_ = null as any;
      this.parserFactory_ = null as any;
      // Null the abrManager and abrManagerFactory, so that they won't be shut
      // down during unload and will continue to live inside the preloadManager.
      this.abrManager_ = null as any;
      this.abrManagerFactory_ = null as any;
    }
    return preloadManager;
  }

  attachAdaptationSetCriteria(adaptationSetCriteria: AdaptationSetCriteria) {
    this.currentAdaptationSetCriteria_ = adaptationSetCriteria;
  }

  attachManifest(manifest: Manifest, parser: IManifestParser, parserFactory: ManifestParserFactory) {
    this.manifest_ = manifest;
    this.parser_ = parser;
    this.parserFactory_ = parserFactory;
  }

  /**
   * Applies playRangeStart and playRangeEnd to the given timeline. This will
   * only affect non-live content.
   * @param timeline
   * @param playRangeStart
   * @param playRangeEnd
   */
  static applyPlayRange_(timeline: PresentationTimeline, playRangeStart: number, playRangeEnd: number) {
    if (playRangeStart > 0) {
      if (timeline.isLive()) {
        log.warning('|playRangeStart| has been configured for live content. ' + 'Ignoring the setting.');
      } else {
        timeline.setUserSeekStart(playRangeStart);
      }
    }

    // If the playback has been configured to end before the end of the
    // presentation, update the duration unless it's live content.
    const fullDuration = timeline.getDuration();
    if (playRangeEnd < fullDuration) {
      if (timeline.isLive()) {
        log.warning('|playRangeEnd| has been configured for live content. ' + 'Ignoring the setting.');
      } else {
        timeline.setDuration(playRangeEnd);
      }
    }
  }

  /**
   * Passes the asset URI along to the media element, so it can be played src
   * equals style.
   * @param startTimeOfLoad
   * @param mimeType
   */
  private async srcEqualsInner_(startTimeOfLoad: number, mimeType: string) {
    this.makeStateChangeEvent_('src-equals');

    asserts.assert(this.video_, 'We should have a media element when loading.');
    asserts.assert(this.assetUri_, 'We should have a valid uri when loading.');

    const mediaElement = this.video_;

    this.playhead_ = new SrcEqualsPlayhead(mediaElement);

    // This flag is used below in the language preference setup to check if
    // this load was canceled before the necessary awaits completed.
    let unloaded = false;
    this.cleanupOnUnload_.push(() => {
      unloaded = true;
    });

    if (this.startTime_ !== null) {
      this.playhead_.setStartTime(this.startTime_);
    }

    this.playRateController_ = new PlayRateController({
      getRate: () => mediaElement.playbackRate,
      getDefaultRate: () => mediaElement.defaultPlaybackRate,
      setRate: (rate) => (mediaElement.playbackRate = rate),
      movePlayhead: (delta) => {
        mediaElement.currentTime += delta;
      },
    });

    const rebufferThreshold = this.config_.streaming.rebufferingGoal;
    this.startBufferManagement_(mediaElement, rebufferThreshold);

    const updateStateHistory = () => this.updateStateHistory_();
    const onRateChange = () => this.onRateChange_();

    this.loadEventManager_.listen(mediaElement, 'playing', updateStateHistory);
    this.loadEventManager_.listen(mediaElement, 'pause', updateStateHistory);
    this.loadEventManager_.listen(mediaElement, 'ended', updateStateHistory);
    this.loadEventManager_.listen(mediaElement, 'ratechange', onRateChange);

    // Wait for the 'loadedmetadata' event to measure load() latency, but only
    // if preload is set in a way that would result in this event firing
    // automatically.
    // See https://github.com/shaka-project/shaka-player/issues/2483
    if (mediaElement.preload !== 'none') {
      this.loadEventManager_.listenOnce(mediaElement, 'loadedmetadata', () => {
        const now = Date.now() / 1000;
        const delta = now - startTimeOfLoad;
        this.stats_.setLoadLatency(delta);
      });
    }
    // The audio tracks are only available on Safari at the moment, but this
    // drives the tracks API for Safari's native HLS. So when they change,
    // fire the corresponding Shaka Player event.
    // 只有safari支持
    // if (mediaElement.audioTracks) {
    //   // @ts-expect-error
    //   this.loadEventManager_.listen(mediaElement.audioTracks, 'addtrack', () => this.onTracksChanged_());
    //   // @ts-expect-error
    //   this.loadEventManager_.listen(mediaElement.audioTracks, 'removetrack', () => this.onTracksChanged_());
    //   // @ts-expect-error
    //   this.loadEventManager_.listen(mediaElement.audioTracks, 'change', () => this.onTracksChanged_());
    // }

    if (mediaElement.textTracks) {
      this.loadEventManager_.listen(mediaElement.textTracks, 'addtrack', (e) => {
        const trackEvent = e as TrackEvent;

        if (trackEvent.track) {
          const track = trackEvent.track;
          asserts.assert(track instanceof TextTrack, 'Wrong track type!');
          switch (track.kind) {
            case 'metadata':
              this.processTimedMetadataSrcEqls_(track);
              break;

            case 'chapters':
              this.activateChaptersTrack_(track);
              break;

            default:
              this.onTracksChanged_();
              break;
          }
        }
      });

      this.loadEventManager_.listen(mediaElement.textTracks, 'removetrack', () => this.onTracksChanged_());
      this.loadEventManager_.listen(mediaElement.textTracks, 'change', () => this.onTracksChanged_());
    }

    // By setting |src| we are done "loading" with src=. We don't need to set
    // the current time because |playhead| will do that for us.
    // TODO(sanfeng): CmcdManager
    // mediaElement.src = this.cmcdManager_.appendSrcData(this.assetUri_, mimeType);
    mediaElement.src = this.assetUri_!;

    // Tizen 3 / WebOS won't load anything unless you call load() explicitly,
    // no matter the value of the preload attribute.  This is harmful on some
    // other platforms by triggering unbounded loading of media data, but is
    // necessary here.
    if (Platform.isTizen() || Platform.isWebOS()) {
      mediaElement.load();
    }

    // In Safari using HLS won't load anything unless you call load()
    // explicitly, no matter the value of the preload attribute.
    // Note: this only happens when there are not autoplay.
    if (
      mediaElement.preload != 'none' &&
      !mediaElement.autoplay &&
      MimeUtils.isHlsType(mimeType) &&
      Platform.safariVersion()
    ) {
      mediaElement.load();
    }

    // Set the load mode last so that we know that all our components are
    // initialized.
    this.loadMode_ = Player.LoadMode.SRC_EQUALS;

    // The event doesn't mean as much for src= playback, since we don't
    // control streaming.  But we should fire it in this path anyway since
    // some applications may be expecting it as a life-cycle event.
    this.dispatchEvent(Player.makeEvent_(FakeEvent.EventName.Streaming));

    // The "load" Promise is resolved when we have loaded the metadata.  If we
    // wait for the full data, that won't happen on Safari until the play
    // button is hit.
    const fullyLoaded = new PublicPromise();
    MediaReadyState.waitForReadyState(mediaElement, HTMLMediaElement.HAVE_METADATA, this.loadEventManager_, () => {
      this.playhead_.ready();
      fullyLoaded.resolve();
    });

    MediaReadyState.waitForReadyState(
      mediaElement,
      HTMLMediaElement.HAVE_CURRENT_DATA,
      this.loadEventManager_,
      async () => {
        this.setupPreferredAudioOnSrc_();

        // Applying the text preference too soon can result in it being
        // reverted.  Wait for native HLS to pick something first.
        // TODO: TextEngine
        // const textTracks = this.getFilteredTextTracks_();
        // if (!textTracks.find((t) => t.mode != 'disabled')) {
        //   await new Promise((resolve) => {
        //     this.loadEventManager_.listenOnce(mediaElement.textTracks, 'change', resolve);

        //     // We expect the event to fire because it does on Safari.
        //     // But in case it doesn't on some other platform or future
        //     // version, move on in 1 second no matter what.  This keeps the
        //     // language settings from being completely ignored if something
        //     // goes wrong.
        //     new Timer(resolve).tickAfter(1);
        //   });
        // } else if (textTracks.length > 0) {
        //   this.isTextVisible_ = true;
        // }
        // If we have moved on to another piece of content while waiting for
        // the above event/timer, we should not change tracks here.
        // if (unloaded) {
        //   return;
        // }

        // this.setupPreferredTextOnSrc_();
      }
    );

    if (mediaElement.error) {
      // Already failed!
      fullyLoaded.reject(this.videoErrorToShakaError_());
    } else if (mediaElement.preload === 'none') {
      log.alwaysWarn(
        'With <video preload="none">, the browser will not load anything ' +
          'until play() is called. We are unable to measure load latency ' +
          'in a meaningful way, and we cannot provide track info yet. ' +
          'Please do not use preload="none" with Shaka Player.'
      );
      // We can't wait for an event load loadedmetadata, since that will be
      // blocked until a user interaction.  So resolve the Promise now.
      fullyLoaded.resolve();
    }

    this.loadEventManager_.listenOnce(mediaElement, 'error', () => {
      fullyLoaded.reject(this.videoErrorToShakaError_());
    });

    const timeout = new Promise((resolve, reject) => {
      const timer = new Timer(reject);
      timer.tickAfter(this.config_.streaming.loadTimeout);
    });

    await Promise.race([fullyLoaded, timeout]);
    const isLive = this.isLive();
    if (
      (isLive && (this.config_.streaming.liveSync.enabled || this.config_.streaming.liveSync.panicMode)) ||
      this.config_.streaming.vodDynamicPlaybackRate
    ) {
      const onTimeUpdate = () => this.onTimeUpdate_();
      this.loadEventManager_.listen(mediaElement, 'timeupdate', onTimeUpdate);
    }

    if (!isLive) {
      const onVideoProgress = () => this.onVideoProgress_();
      this.loadEventManager_.listen(mediaElement, 'timeupdate', onVideoProgress);
      this.onVideoProgress_();
    }
    // TODO: AdManager
    // if (this.adManager_) {

    // }

    this.fullyLoaded_ = true;
  }

  private activateChaptersTrack_(track: TextTrack) {
    if (track.kind !== 'chapters') {
      return;
    }

    // Hidden mode is required for the cuechange event to launch correctly and
    // get the cues and the activeCues
    track.mode = 'hidden';

    // In Safari the initial assignment does not always work, so we schedule
    // this process to be repeated several times to ensure that it has been put
    // in the correct mode.
    const timer = new Timer(() => {
      track.mode = 'hidden';
    })
      .tickNow()
      .tickAfter(0.5);

    this.cleanupOnUnload_.push(() => {
      timer.stop();
    });
  }

  /**
   *  Sets the current audio language and current variant role to the selected
   * language, role and channel count, and chooses a new variant if need be.
   * If the player has not loaded any content, this will be a no-op.
   * This method setup the preferred audio using src=..
   */
  private setupPreferredAudioOnSrc_() {
    const preferredAudioLanguage = this.config_.preferredAudioLanguage;

    // If the user has not selected a preference, the browser preference is
    // left.
    if (!preferredAudioLanguage) {
      return;
    }

    const preferredVariantRole = this.config_.preferredVariantRole;

    this.selectAudioLanguage(preferredAudioLanguage, preferredVariantRole);
  }

  /**
   * Sets the current audio language and current variant role to the selected
   * language, role and channel count, and chooses a new variant if need be.
   * If the player has not loaded any content, this will be a no-op.
   * @param language
   * @param role
   * @param channelsCount
   * @param safeMargin
   * @param codec
   */
  selectAudioLanguage(language: string, role: string | null, channelsCount = 0, safeMargin = 0, codec = '') {
    if (this.manifest_ && this.playhead_) {
      // TODO: Dash
      this.currentAdaptationSetCriteria_ = new PreferenceBasedCriteria(
        language,
        role || '',
        channelsCount,
        '',
        false,
        '',
        '',
        '',
        this.config_.mediaSource.codecSwitchingStrategy,
        this.config_.manifest.dash.enableAudioGroups
      );
    }
  }

  /**
   * We're looking for metadata tracks to process id3 tags. One of the uses is
   * for ad info on LIVE streams
   * @param track
   */
  private processTimedMetadataSrcEqls_(track: TextTrack) {
    if (track.kind !== 'metadata') {
      return;
    }

    // Hidden mode is required for the cuechange event to launch correctly
    track.mode = 'hidden';

    this.loadEventManager_.listen(track, 'cuechange', () => {
      if (!track.activeCues) {
        return;
      }

      const interstitials: Interstitial[] = [];
      for (const cue of track.activeCues as any) {
        this.dispatchMetadataEvent_(cue.startTime, cue.endTime, cue.type, cue.value);

        // TODO(sanfeng): adManager

        if (cue.type == 'com.apple.quicktime.HLS' && cue.startTime != null) {
          let interstitial = interstitials.find((i) => {
            return i.startTime == cue.startTime && i.endTime == cue.endTime;
          });
          if (!interstitial) {
            interstitial = { startTime: cue.startTime, endTime: cue.endTime, values: [] };
            interstitials.push(interstitial);
          }
          interstitial.values.push(cue.value);
        }
        // TODO(sanfeng): adManager
      }
    });

    // In Safari the initial assignment does not always work, so we schedule
    // this process to be repeated several times to ensure that it has been put
    // in the correct mode.
    const timer = new Timer(() => {
      const textTracks = this.getMetadataTracks_();
      for (const track of textTracks) {
        track.mode = 'hidden';
      }
    })
      .tickNow()
      .tickEvery(0.5);

    this.cleanupOnUnload_.push(() => {
      timer.stop();
    });
  }

  /**
   * Get the TextTracks with the 'metadata' kind.
   * @returns
   */
  private getMetadataTracks_() {
    return Array.from(this.video_.textTracks).filter((track) => track.kind === 'metadata');
  }

  /**
   * Dispatches a 'trackschanged' event.
   * @private
   */
  private onTracksChanged_() {
    // Delay the 'trackschanged' event so StreamingEngine has time to absorb the
    // changes before the user tries to query it.
    const event = Player.makeEvent_(FakeEvent.EventName.TracksChanged);
    this.delayDispatchEvent_(event);
  }

  /**
   * A callback for when the playback rate changes. We need to watch the
   * playback rate so that if the playback rate on the media element changes
   * (that was not caused by our play rate controller) we can notify the
   * controller so that it can stay in-sync with the change.
   *
   */
  private onRateChange_() {
    const newRate = this.video_.playbackRate;

    // On Edge, when someone seeks using the native controls, it will set the
    // playback rate to zero until they finish seeking, after which it will
    // return the playback rate.
    //
    // If the playback rate changes while seeking, Edge will cache the playback
    // rate and use it after seeking.
    //
    // https://github.com/shaka-project/shaka-player/issues/951
    if (newRate === 0) {
      return;
    }

    if (this.playRateController_) {
      // The playback rate has changed. This could be us or someone else.
      // If this was us, setting the rate again will be a no-op.
      this.playRateController_.set(newRate);
    }

    const event = Player.makeEvent_(FakeEvent.EventName.RateChange);
    this.dispatchEvent(event);
  }

  /**
   * Initialize and start the buffering system (observer and timer) so that we
   * can monitor our buffer lead during playback.
   * @param mediaElement
   * @param rebufferingGoal
   */
  private startBufferManagement_(mediaElement: HTMLMediaElement, rebufferingGoal: number) {
    asserts.assert(!this.bufferObserver_, 'No buffering observer should exist before initialization.');

    asserts.assert(!this.bufferPoller_, 'No buffer timer should exist before initialization.');
    // Give dummy values, will be updated below.
    this.bufferObserver_ = new BufferingObserver(1, 2);

    //Force us back to a buffering state. This ensure everything is starting in
    // the same state.
    this.updateBufferingSettings_(rebufferingGoal);
    this.updateBufferState_();
    this.bufferPoller_ = new Timer(() => {
      this.pollBufferState_();
    }).tickEvery(0.25);

    this.loadEventManager_.listen(mediaElement, 'waiting', () => {
      this.pollBufferState_();
    });
    this.loadEventManager_.listen(mediaElement, 'stalled', () => {
      this.pollBufferState_();
    });
    this.loadEventManager_.listen(mediaElement, 'canplaythrough', () => {
      this.pollBufferState_();
    });
    this.loadEventManager_.listen(mediaElement, 'progress', () => {
      this.pollBufferState_();
    });
  }
  /**
   * This method is called periodically to check what the buffering observer
   * says so that we can update the rest of the buffering behaviours.
   *
   */
  private pollBufferState_() {
    asserts.assert(this.video_, 'Need a media element to update the buffering observer');

    asserts.assert(this.bufferObserver_, 'Need a buffering observer to update');

    let bufferedToEnd: boolean;

    switch (this.loadMode_) {
      case Player.LoadMode.SRC_EQUALS:
        bufferedToEnd = this.isBufferedToEndSrc_();
        break;

      case Player.LoadMode.MEDIA_SOURCE:
        bufferedToEnd = this.isBufferedToEndMS_();
        break;
      default:
        bufferedToEnd = false;
        break;
    }

    const bufferLead = TimeRangesUtils.bufferedAheadOf(this.video_.buffered, this.video_.currentTime);

    const stateChanged = this.bufferObserver_.update(bufferLead, bufferedToEnd);

    if (stateChanged) {
      this.updateBufferState_();
    }
  }

  /**
   *  Assuming the player is playing content with media source, check if the
   * player has buffered enough content to make it to the end of the
   * presentation.
   */
  private isBufferedToEndMS_() {
    asserts.assert(this.mediaSourceEngine_, 'We need a media source engine to get buffering information');
    asserts.assert(this.manifest_, 'We need a manifest to get buffering information');
    asserts.assert(this.video_, 'We need a video element to get buffering information');
    // This is a strong guarantee that we are buffered to the end, because it
    // means the playhead is already at that end.
    if (this.video_.ended) {
      return true;
    }
    // This means that MediaSource has buffered the final segment in all
    // SourceBuffers and is no longer accepting additional segments.
    if (this.mediaSourceEngine_.ended()) {
      return true;
    }

    // Live streams are "buffered to the end" when they have buffered to the
    // live edge or beyond (into the region covered by the presentation delay).
    if (this.manifest_.presentationTimeline.isLive()) {
      const liveEdge = this.manifest_.presentationTimeline.getSegmentAvailabilityEnd();
      const bufferEnd = TimeRangesUtils.bufferEnd(this.video_.buffered);
      if (bufferEnd !== null && bufferEnd >= liveEdge) {
        return true;
      }
    }
    return false;
  }

  /**
   * Assuming the player is playing content with src=, check if the player has
   * buffered enough content to make it to the end of the presentation.
   *
   */
  private isBufferedToEndSrc_() {
    asserts.assert(this.video_, 'We need a video element to get buffering information');

    // This is a strong guarantee that we are buffered to the end, because it
    // means the playhead is already at that end.
    if (this.video_.ended) {
      return true;
    }
    // If we have buffered to the duration of the content, it means we will have
    // enough content to buffer to the end of the presentation.

    const bufferEnd = TimeRangesUtils.bufferEnd(this.video_.buffered);

    // Because Safari's native HLS reports slightly inaccurate values for
    // bufferEnd here, we use a fudge factor.  Without this, we can end up in a
    // buffering state at the end of the stream.  See issue #2117.
    const fudge = 1; // 1000 ms
    return bufferEnd != null && bufferEnd >= this.video_.duration - fudge;
  }

  private updateBufferingSettings_(rebufferingGoal: number) {
    // The threshold to transition back to satisfied when starving.
    const starvingThreshold = rebufferingGoal;

    // The threshold to transition into starving when satisfied.
    // We use a "typical" threshold, unless the rebufferingGoal is unusually
    // low.
    // Then we force the value down to half the rebufferingGoal, since
    // starvingThreshold must be strictly larger than satisfiedThreshold for the
    // logic in BufferingObserver to work correctly.
    const satisfiedThreshold = Math.min(Player.TYPICAL_BUFFERING_THRESHOLD_, rebufferingGoal / 2);

    this.bufferObserver_.setThresholds(starvingThreshold, satisfiedThreshold);
  }

  private async preloadInner_(
    assetUri: string,
    startTime: number | null,
    mimeType: string | null,
    standardLoad = false
  ) {
    asserts.assert(this.networkingEngine_, 'Should have a net engine!');
    asserts.assert(this.config_, 'Config must not be null!');
    const startTimeOfLoad = Date.now() / 1000;
    if (!mimeType) {
      mimeType = await this.guessMimeType_(assetUri);
    }

    const shouldUseSrcEquals = this.shouldUseSrcEquals_(assetUri, mimeType);

    if (shouldUseSrcEquals) {
      // We cannot preload src= content.
      return null;
    }
    let disableVideo = false;
    let allowMakeAbrManager = true;

    if (standardLoad) {
      if (this.abrManager_ && this.abrManagerFactory_ === this.config_.abrFactory) {
        // If there's already an abr manager, don't make a new abr manager at
        // all.
        // In standardLoad mode, the abr manager isn't used for anything anyway,
        // so it should only be created to create an abr manager for the player
        // to use... which is unnecessary if we already have one of the right
        // type.
        allowMakeAbrManager = false;
      }
      if (this.video_ && this.video_.nodeName === 'AUDIO') {
        disableVideo = true;
      }
    }
    let preloadManagerPromise = this.makePreloadManager_(
      assetUri,
      startTime,
      mimeType || null,
      startTimeOfLoad,
      /* allowPrefetch= */ !standardLoad,
      disableVideo,
      allowMakeAbrManager
    );
    if (!standardLoad) {
      // We only need to track the PreloadManager if it is not part of a
      // standard load. If it is, the load() method will handle destroying it.
      // Adding a standard load PreloadManager to the createdPreloadManagers_
      // array runs the risk that the user will call destroyAllPreloads and
      // destroy that PreloadManager mid-load.
      preloadManagerPromise = preloadManagerPromise.then((preloadManager) => {
        this.createdPreloadManagers_.push(preloadManager);
        return preloadManager;
      });
    }
    return preloadManagerPromise;
  }

  private async makePreloadManager_(
    assetUri: string,
    startTime: number | null,
    mimeType: string | null,
    startTimeOfLoad: number,
    allowPrefetch = true,
    disableVideo = false,
    allowMakeAbrManager = true
  ) {
    asserts.assert(this.networkingEngine_, 'Must have net engine');
    let preloadManager: PreloadManager = null as any;
    const config = ObjectUtils.cloneObject(this.config_);
    if (disableVideo) {
      config.manifest.disableVideo = true;
    }
    const getPreloadManager = (): PreloadManager | null => {
      asserts.assert(preloadManager, 'Must have preload manager');
      if (preloadManager!.hasBeenAttached() && preloadManager!.isDestroyed()) {
        return null;
      }
      return preloadManager;
    };

    const getConfig = () => {
      if (getPreloadManager()) {
        return getPreloadManager()!.getConfiguration();
      }
      return this.config_;
    };

    const setConfig = (name: string, value: any) => {
      if (getPreloadManager()) {
        getPreloadManager()!.configure(name, value);
      } else {
        this.configure(name, value);
      }
    };

    // Avoid having to detect the resolution again if it has already been
    // detected or set
    if (this.maxHwRes_.width == Infinity && this.maxHwRes_.height == Infinity) {
      const maxResolution = await Platform.detectMaxHardwareResolution();
      this.maxHwRes_.width = maxResolution.width;
      this.maxHwRes_.height = maxResolution.height;
    }

    const manifestFilterer = new ManifestFilterer(config, this.maxHwRes_, null);

    const manifestPlayerInterface: ManifestParserPlayerInterface = {
      networkingEngine: this.networkingEngine_,
      filter: async (manifest) => {
        const tracksChanged = await manifestFilterer.filterManifest(manifest);
        if (tracksChanged) {
          // Delay the 'trackschanged' event so StreamingEngine has time to
          // absorb the changes before the user tries to query it.
          const event = Player.makeEvent_(FakeEvent.EventName.TracksChanged);
          await Promise.resolve();
          preloadManager.dispatchEvent(event);
        }
      },

      makeTextStreamsForClosedCaptions: (manifest) => {
        // TODO(sanfeng): TextEngine
        // return this.makeTextStreamsForClosedCaptions_(manifest);
      },

      // Called when the parser finds a timeline region. This can be called
      // before we start playback or during playback (live/in-progress
      // manifest).
      onTimelineRegionAdded: (region) => {
        preloadManager.getRegionTimeline().addRegion(region);
      },

      onEvent: (event) => preloadManager.dispatchEvent(event as any),
      onError: (error) => preloadManager.onError(error),
      isLowLatencyMode: () => getConfig().streaming.lowLatencyMode,
      isAutoLowLatencyMode: () => getConfig().streaming.autoLowLatencyMode,
      enableLowLatencyMode: () => {
        setConfig('streaming.lowLatencyMode', true);
      },
      updateDuration: () => {
        if (this.streamingEngine_ && preloadManager.hasBeenAttached()) {
          this.streamingEngine_.updateDuration();
        }
      },
      newDrmInfo: (stream) => {
        // TODO(sanfeng): DrmEngine
        // We may need to create new sessions for any new init data.
        // const drmEngine = preloadManager.getDrmEngine();
        // const currentDrmInfo = drmEngine ? drmEngine.getDrmInfo() : null;
        // // DrmEngine.newInitData() requires mediaKeys to be available.
        // if (currentDrmInfo && drmEngine.getMediaKeys()) {
        //   manifestFilterer.processDrmInfos(currentDrmInfo.keySystem, stream);
        // }
      },
      onManifestUpdated: () => {
        const eventName = FakeEvent.EventName.ManifestUpdated;
        const data = new Map().set('isLive', this.isLive());
        preloadManager.dispatchEvent(Player.makeEvent_(eventName, data));

        preloadManager.addQueuedOperation(false, () => {
          // TODO(sanfeng): AdManager
          // if (this.adManager_) {
          //   this.adManager_.onManifestUpdated(this.isLive());
          // }
        });
      },
      getBandwidthEstimate: () => this.abrManager_.getBandwidthEstimate(),
      onMetadata: (type, startTime, endTime, values) => {
        let metadataType = type;
        if (type == 'com.apple.hls.interstitial') {
          metadataType = 'com.apple.quicktime.HLS';

          // const interstitial = {
          //   startTime,
          //   endTime,
          //   values,
          // };
          // if (this.adManager_) {
          //   goog.asserts.assert(this.video_, 'Must have video');
          //   this.adManager_.onInterstitialMetadata(this, this.video_, interstitial);
          // }
        }
        for (const payload of values) {
          preloadManager.addQueuedOperation(false, () => {
            this.dispatchMetadataEvent_(startTime, endTime, metadataType, payload);
          });
        }
      },
      disableStream: (stream) => {
        this.disableStream(stream, this.config_.streaming.maxDisabledTime);
      },
    };

    const regionTimeline = new RegionTimeline(() => this.seekRange());
    regionTimeline.addEventListener('regionadd', (event: any) => {
      const region = event['region'];
      this.onRegionEvent_(FakeEvent.EventName.TimelineRegionAdded, region, preloadManager);

      preloadManager.addQueuedOperation(false, () => {
        // TODO: AdManager
        // if (this.adManager_) {
        //   this.adManager_.onDashTimedMetadata(region);
        // }
      });
    });

    let qualityObserver: QualityObserver | null = null;
    if (config.streaming.observeQualityChanges) {
      qualityObserver = new QualityObserver(() => this.getBufferedInfo());

      qualityObserver.addEventListener('qualitychange', (event: any) => {
        const mediaQualityInfo = event['quality'];
        const position = event['position'];
        this.onMediaQualityChange_(mediaQualityInfo, position);
      });
    }
    // TODO(safeng): DrmEngine
    //let firstEvent = true;
    // const drmPlayerInterface = {
    //   netEngine: this.networkingEngine_,
    //   onError: (e) => preloadManager.onError(e),
    //   onKeyStatus: (map) => {
    //     preloadManager.addQueuedOperation(true, () => {
    //       this.onKeyStatus_(map);
    //     });
    //   },
    //   onExpirationUpdated: (id, expiration) => {
    //     const event = Player.makeEvent_(
    //         util.FakeEvent.EventName.ExpirationUpdated);
    //     preloadManager.dispatchEvent(event);
    //     const parser = preloadManager.getParser();
    //     if (parser && parser.onExpirationUpdated) {
    //       parser.onExpirationUpdated(id, expiration);
    //     }
    //   },
    //   onEvent: (e) => {
    //     preloadManager.dispatchEvent(e);
    //     if (e.type == util.FakeEvent.EventName.DrmSessionUpdate &&
    //         firstEvent) {
    //       firstEvent = false;
    //       const now = Date.now() / 1000;
    //       const delta = now - preloadManager.getStartTimeOfDRM();
    //       const stats = this.stats_ || preloadManager.getStats();
    //       stats.setDrmTime(delta);
    //       // LCEVC data by itself is not encrypted in DRM protected streams
    //       // and can therefore be accessed and decoded as normal. However,
    //       // the LCEVC decoder needs access to the VideoElement output in
    //       // order to apply the enhancement. In DRM contexts where the
    //       // browser CDM restricts access from our decoder, the enhancement
    //       // cannot be applied and therefore the LCEVC output canvas is
    //       // hidden accordingly.
    //       if (this.lcevcDec_) {
    //         this.lcevcDec_.hideCanvas();
    //       }
    //     }
    //   },
    // };

    // Sadly, as the network engine creation code must be replaceable by tests,
    // it cannot be made and use the utilities defined in this function.
    const networkingEngine = this.createNetworkingEngine(getPreloadManager);
    this.networkingEngine_.copyFiltersInto(networkingEngine);

    // @ts-expect-error
    const createDrmEngine = (): DrmEngine => {
      // TODO(sanfeng): DRMEngine
      // return this.createDrmEngine(drmPlayerInterface);
    };

    const playerInterface: PreloadManagerPlayerInterface = {
      config,
      manifestPlayerInterface,
      regionTimeline,
      qualityObserver,
      createDrmEngine,
      manifestFilterer,
      networkingEngine,
      allowPrefetch,
      allowMakeAbrManager,
    };
    preloadManager = new PreloadManager(assetUri, mimeType, startTimeOfLoad, startTime, playerInterface);
    return preloadManager;
  }

  /**
   * Temporarily disable all variants containing |stream|
   * @param stream
   * @param disableTime
   * @return
   */
  disableStream(stream: Stream, disableTime: number) {
    if (!this.config_.abr.enabled || this.loadMode_ === Player.LoadMode.DESTROYED) {
      return false;
    }

    if (!navigator.onLine) {
      // Don't disable variants if we're completely offline, or else we end up
      // rapidly restricting all of them.
      return false;
    }

    // It only makes sense to disable a stream if we have an alternative else we
    // end up disabling all variants.
    const hasAltStream = this.manifest_.variants.some((variant) => {
      // @ts-expect-error
      const altStream = variant[stream.type];

      if (altStream && altStream.id !== stream.id) {
        if (StreamUtils.isAudio(stream)) {
          return stream.language === altStream.language;
        }
        return true;
      }
      return false;
    });

    if (hasAltStream) {
      let didDisableStream = false;

      for (const variant of this.manifest_.variants) {
        // @ts-expect-error
        const candidate = variant[stream.type];

        if (candidate && candidate.id === stream.id) {
          variant.disabledUntilTime = Date.now() / 1000 + disableTime;
          didDisableStream = true;

          log.v2('Disabled stream ' + stream.type + ':' + stream.id + ' for ' + disableTime + ' seconds...');
        }
      }

      asserts.assert(didDisableStream, 'Must have disabled stream');

      this.checkVariantsTimer_.tickEvery(1);

      // Get the safeMargin to ensure a seamless playback
      const { video } = this.getBufferedInfo();
      const safeMargin = video.reduce((size, { start, end }) => size + end - start, 0);

      // Update abr manager variants and switch to recover playback
      this.chooseVariantAndSwitch_(
        /* clearBuffer= */ true,
        /* safeMargin= */ safeMargin,
        /* force= */ true,
        /* fromAdaptation= */ false
      );
      return true;
    }

    log.warning(
      'No alternate stream found for active ' + stream.type + ' stream. ' + 'Will ignore request to disable stream...'
    );

    return false;
  }
  /**
   * Chooses a new Variant.  If the new variant differs from the old one, it
   * adds the new one to the switch history and switches to it.
   *
   * Called after a config change, a key status event, or an explicit language
   * change.
   *
   * @param clearBuffer Optional clear buffer or not when
   *  switch to new variant
   *  Defaults to true if not provided
   * @param safeMargin Optional amount of buffer (in seconds) to
   *   retain when clearing the buffer.
   *   Defaults to 0 if not provided. Ignored if clearBuffer is false.
   */
  private chooseVariantAndSwitch_(clearBuffer = true, safeMargin = 0, force = false, fromAdaptation = true) {
    asserts.assert(this.config_, 'Must not be destroyed');
    const chosenVariant = this.chooseVariant_();
    if (chosenVariant) {
      this.switchVariant_(chosenVariant, fromAdaptation, clearBuffer, safeMargin, force);
    }
  }

  /**
   * Get the range of time (in seconds) that seeking is allowed. If the player
   * has not loaded content and the manifest is HLS, this will return a range
   * from 0 to 0.
   */
  seekRange() {
    if (this.manifest_) {
      // With HLS lazy-loading, there were some situations where the manifest
      // had partially loaded, enough to move onto further load stages, but no
      // segments had been loaded, so the timeline is still unknown.
      // See: https://github.com/shaka-project/shaka-player/pull/4590
      if (!this.fullyLoaded_ && this.manifest_.type == ManifestParser.HLS) {
        return { start: 0, end: 0 };
      }
      const timeline = this.manifest_.presentationTimeline;

      return {
        start: timeline.getSeekRangeStart(),
        end: timeline.getSeekRangeEnd(),
      };
    }

    // If we have loaded content with src=, we ask the video element for its
    // seekable range.  This covers both plain mp4s and native HLS playbacks.
    if (this.video_ && this.video_.src) {
      const seekable = this.video_.seekable;
      if (seekable.length) {
        return {
          start: seekable.start(0),
          end: seekable.end(seekable.length - 1),
        };
      }
    }

    return { start: 0, end: 0 };
  }

  /**
   * When we fire region events, we need to copy the information out of the
   * region to break the connection with the player's internal data. We do the
   * copy here because this is the transition point between the player and the
   * app.
   *
   * @param eventName
   * @param region
   * @param  eventTarget
   *
   */
  private onRegionEvent_(eventName: string, region: TimelineRegionInfo, eventTarget: FakeEventTarget = this) {
    // Always make a copy to avoid exposing our internal data to the app.
    const clone = {
      schemeIdUri: region.schemeIdUri,
      value: region.value,
      startTime: region.startTime,
      endTime: region.endTime,
      id: region.id,
      eventElement: region.eventElement,
      eventNode: region.eventNode,
    };

    const data = new Map().set('detail', clone);
    eventTarget.dispatchEvent(Player.makeEvent_(eventName, data));
  }

  /**
   * When notified of a media quality change we need to emit a
   * MediaQualityChange event to the app.
   *
   * @param {extern.MediaQualityInfo} mediaQuality
   * @param {number} position
   *
   * @private
   */
  private onMediaQualityChange_(mediaQuality: MediaQualityInfo, position: number) {
    // Always make a copy to avoid exposing our internal data to the app.
    const clone = {
      bandwidth: mediaQuality.bandwidth,
      audioSamplingRate: mediaQuality.audioSamplingRate,
      codecs: mediaQuality.codecs,
      contentType: mediaQuality.contentType,
      frameRate: mediaQuality.frameRate,
      height: mediaQuality.height,
      mimeType: mediaQuality.mimeType,
      channelsCount: mediaQuality.channelsCount,
      pixelAspectRatio: mediaQuality.pixelAspectRatio,
      width: mediaQuality.width,
    };

    const data = new Map().set('mediaQuality', clone).set('position', position);

    this.dispatchEvent(Player.makeEvent_(FakeEvent.EventName.MediaQualityChanged, data));
  }

  /**
   * Creates a new instance of NetworkingEngine.  This can be replaced by tests
   * to create fake instances instead.
   *
   * @param {(function():?media.PreloadManager)=} getPreloadManager
   * @return {!net.NetworkingEngine}
   */
  createNetworkingEngine(getPreloadManager: (() => PreloadManager | null) | null = null) {
    if (!getPreloadManager) {
      getPreloadManager = () => null;
    }

    if (!getPreloadManager) {
      throw new Error('getPreloadManager should not be null');
    }

    const getAbrManager = () => {
      if (getPreloadManager()) {
        return getPreloadManager()!.getAbrManager();
      } else {
        return this.abrManager_;
      }
    };
    const getParser = () => {
      if (getPreloadManager()) {
        return getPreloadManager()!.getParser();
      } else {
        return this.parser_;
      }
    };
    const lateQueue = (fn: Function) => {
      if (getPreloadManager()) {
        getPreloadManager()!.addQueuedOperation(true, fn);
      } else {
        fn();
      }
    };
    const dispatchEvent = (event: FakeEvent) => {
      if (getPreloadManager()) {
        getPreloadManager()!.dispatchEvent(event);
      } else {
        this.dispatchEvent(event);
      }
    };
    const getStats = () => {
      if (getPreloadManager()) {
        return getPreloadManager()!.getStats();
      } else {
        return this.stats_;
      }
    };

    const onProgressUpdated_: OnProgressUpdated = (deltaTimeMs, bytesDownloaded, allowSwitch, request) => {
      // In some situations, such as during offline storage, the abr manager
      // might not yet exist. Therefore, we need to check if abr manager has
      // been initialized before using it.
      const abrManager = getAbrManager();
      if (abrManager) {
        abrManager.segmentDownloaded(deltaTimeMs, bytesDownloaded, allowSwitch, request);
      }
    };
    const onHeadersReceived_: OnHeadersReceived = (headers, request, requestType) => {
      // Release a 'downloadheadersreceived' event.
      const name = FakeEvent.EventName.DownloadHeadersReceived;
      const data = new Map().set('headers', headers).set('request', request).set('requestType', requestType);
      dispatchEvent(Player.makeEvent_(name, data));
      // TODO(sanfeng): CmsdManager
      //  lateQueue(() => {
      //   if (this.cmsdManager_) {
      //     this.cmsdManager_.processHeaders(headers);
      //   }
      // });
    };

    const onDownloadFailed_: OnDownloadFailed = (request, error, httpResponseCode, aborted) => {
      // Release a 'downloadfailed' event.
      const name = FakeEvent.EventName.DownloadFailed;
      const data = new Map()
        .set('request', request)
        .set('error', error)
        .set('httpResponseCode', httpResponseCode)
        .set('aborted', aborted);
      dispatchEvent(Player.makeEvent_(name, data));
    };

    const onRequest_: OnRequest = (type, request, context) => {
      // TODO(sanfeng): CmcdManager
      // lateQueue(() => {
      //   this.cmcdManager_.applyData(type, request, context);
      // });
    };
    const onRetry_: OnRetry = (type, context, newUrl, oldUrl) => {
      const parser = getParser();
      if (parser && parser.banLocation) {
        parser.banLocation(oldUrl);
      }
    };
    const onResponse_: OnResponse = (type, response, context) => {
      if (response.data) {
        const bytesDownloaded = response.data.byteLength;
        const stats = getStats();
        if (stats) {
          stats.addBytesDownloaded(bytesDownloaded);
          if (type === NetworkingEngineRequestType.MANIFEST) {
            stats.setManifestSize(bytesDownloaded);
          }
        }
      }
    };

    return new NetworkingEngine(
      onProgressUpdated_,
      onHeadersReceived_,
      onDownloadFailed_,
      onRequest_,
      onRetry_,
      onResponse_
    );
  }

  /**
   * Get information about what the player has buffered. If the player has not
   * loaded content or is currently loading content, the buffered content will
   * be empty.
   *
   * @export
   */
  getBufferedInfo() {
    if (this.loadMode_ == Player.LoadMode.MEDIA_SOURCE) {
      return this.mediaSourceEngine_.getBufferedInfo();
    }

    const info: BufferedInfo = {
      total: [],
      audio: [],
      video: [],
      text: [],
    };

    if (this.loadMode_ == Player.LoadMode.SRC_EQUALS) {
      info.total = TimeRangesUtils.getBufferedInfo(this.video_.buffered);
    }

    return info;
  }

  /**
   * Changes configuration settings on the Player.  This checks the names of
   * keys and the types of values to avoid coding errors.  If there are errors,
   * this logs them to the console and returns false.  Correct fields are still
   * applied even if there are other errors.  You can pass an explicit
   * <code>undefined</code> value to restore the default value.  This has two
   * modes of operation:
   *
   * <p>
   * First, this can be passed a single "plain" object.  This object should
   * follow the {@link extern.PlayerConfiguration} object.  Not all fields
   * need to be set; unset fields retain their old values.
   *
   * <p>
   * Second, this can be passed two arguments.  The first is the name of the key
   * to set.  This should be a '.' separated path to the key.  For example,
   * <code>'streaming.alwaysStreamText'</code>.  The second argument is the
   * value to set.
   *
   * @param config This should either be a field name or an
   *   object.
   * @param value In the second mode, this is the value to set.
   * @return {boolean} True if the passed config object was valid, false if
   *   there were invalid entries.
   * @export
   */
  configure(config: Record<string, any> | string, value: any) {
    asserts.assert(this.config_, 'Config must not be null!');
    asserts.assert(typeof config == 'object' || arguments.length == 2, 'String configs should have values!');

    // ('fieldName', value) format
    if (arguments.length == 2 && typeof config == 'string') {
      config = ConfigUtils.convertToConfigObject(config, value);
    }

    if (typeof config !== 'object') {
      return;
    }

    // Deprecate 'streaming.forceTransmuxTS' configuration.
    if (config['streaming'] && 'forceTransmuxTS' in config['streaming']) {
      Deprecate.deprecateFeature(
        5,
        'streaming.forceTransmuxTS configuration',
        'Please Use mediaSource.forceTransmux instead.'
      );
      config['mediaSource']['mediaSource'] = config['streaming']['forceTransmuxTS'];
      delete config['streaming']['forceTransmuxTS'];
    }

    // Deprecate 'streaming.forceTransmux' configuration.
    if (config['streaming'] && 'forceTransmux' in config['streaming']) {
      Deprecate.deprecateFeature(
        5,
        'streaming.forceTransmux configuration',
        'Please Use mediaSource.forceTransmux instead.'
      );
      config['mediaSource']['mediaSource'] = config['streaming']['forceTransmux'];
      delete config['streaming']['forceTransmux'];
    }

    // Deprecate 'streaming.useNativeHlsOnSafari' configuration.
    if (config['streaming'] && 'useNativeHlsOnSafari' in config['streaming']) {
      Deprecate.deprecateFeature(
        5,
        'streaming.useNativeHlsOnSafari configuration',
        'Please Use streaming.useNativeHlsForFairPlay or ' + 'streaming.preferNativeHls instead.'
      );
      config['streaming']['preferNativeHls'] = config['streaming']['useNativeHlsOnSafari'] && Platform.isApple();
      delete config['streaming']['useNativeHlsOnSafari'];
    }

    // Deprecate 'streaming.liveSync' boolean configuration.
    if (config['streaming'] && typeof config['streaming']['liveSync'] == 'boolean') {
      Deprecate.deprecateFeature(5, 'streaming.liveSync', 'Please Use streaming.liveSync.enabled instead.');
      const liveSyncValue = config['streaming']['liveSync'];
      config['streaming']['liveSync'] = {};
      config['streaming']['liveSync']['enabled'] = liveSyncValue;
    }

    // map liveSyncMinLatency and liveSyncMaxLatency to liveSync.targetLatency
    // if liveSync.targetLatency isn't set.
    if (
      config['streaming'] &&
      (!config['streaming']['liveSync'] || !('targetLatency' in config['streaming']['liveSync'])) &&
      ('liveSyncMinLatency' in config['streaming'] || 'liveSyncMaxLatency' in config['streaming'])
    ) {
      const min = config['streaming']['liveSyncMinLatency'] || 0;
      const max = config['streaming']['liveSyncMaxLatency'] || 1;
      const mid = Math.abs(max - min) / 2;
      config['streaming']['liveSync'] = config['streaming']['liveSync'] || {};
      config['streaming']['liveSync']['targetLatency'] = min + mid;
      config['streaming']['liveSync']['targetLatencyTolerance'] = mid;
    }
    // Deprecate 'streaming.liveSyncMaxLatency' configuration.
    if (config['streaming'] && 'liveSyncMaxLatency' in config['streaming']) {
      Deprecate.deprecateFeature(
        5,
        'streaming.liveSyncMaxLatency',
        'Please Use streaming.liveSync.targetLatency and ' +
          'streaming.liveSync.targetLatencyTolerance instead. ' +
          'Or, set the values in your DASH manifest'
      );
      delete config['streaming']['liveSyncMaxLatency'];
    }
    // Deprecate 'streaming.liveSyncMinLatency' configuration.
    if (config['streaming'] && 'liveSyncMinLatency' in config['streaming']) {
      Deprecate.deprecateFeature(
        5,
        'streaming.liveSyncMinLatency',
        'Please Use streaming.liveSync.targetLatency and ' +
          'streaming.liveSync.targetLatencyTolerance instead. ' +
          'Or, set the values in your DASH manifest'
      );
      delete config['streaming']['liveSyncMinLatency'];
    }

    // Deprecate 'streaming.liveSyncTargetLatency' configuration.
    if (config['streaming'] && 'liveSyncTargetLatency' in config['streaming']) {
      Deprecate.deprecateFeature(
        5,
        'streaming.liveSyncTargetLatency',
        'Please Use streaming.liveSync.targetLatency instead.'
      );
      config['streaming']['liveSync'] = config['streaming']['liveSync'] || {};
      config['streaming']['liveSync']['targetLatency'] = config['streaming']['liveSyncTargetLatency'];
      delete config['streaming']['liveSyncTargetLatency'];
    }

    // Deprecate 'streaming.liveSyncTargetLatencyTolerance' configuration.
    if (config['streaming'] && 'liveSyncTargetLatencyTolerance' in config['streaming']) {
      Deprecate.deprecateFeature(
        5,
        'streaming.liveSyncTargetLatencyTolerance',
        'Please Use streaming.liveSync.targetLatencyTolerance instead.'
      );
      config['streaming']['liveSync'] = config['streaming']['liveSync'] || {};
      config['streaming']['liveSync']['targetLatencyTolerance'] = config['streaming']['liveSyncTargetLatencyTolerance'];
      delete config['streaming']['liveSyncTargetLatencyTolerance'];
    }

    // Deprecate 'streaming.liveSyncPlaybackRate' configuration.
    if (config['streaming'] && 'liveSyncPlaybackRate' in config['streaming']) {
      Deprecate.deprecateFeature(
        5,
        'streaming.liveSyncPlaybackRate',
        'Please Use streaming.liveSync.maxPlaybackRate instead.'
      );
      config['streaming']['liveSync'] = config['streaming']['liveSync'] || {};
      config['streaming']['liveSync']['maxPlaybackRate'] = config['streaming']['liveSyncPlaybackRate'];
      delete config['streaming']['liveSyncPlaybackRate'];
    }

    // Deprecate 'streaming.liveSyncMinPlaybackRate' configuration.
    if (config['streaming'] && 'liveSyncMinPlaybackRate' in config['streaming']) {
      Deprecate.deprecateFeature(
        5,
        'streaming.liveSyncMinPlaybackRate',
        'Please Use streaming.liveSync.minPlaybackRate instead.'
      );
      config['streaming']['liveSync'] = config['streaming']['liveSync'] || {};
      config['streaming']['liveSync']['minPlaybackRate'] = config['streaming']['liveSyncMinPlaybackRate'];
      delete config['streaming']['liveSyncMinPlaybackRate'];
    }

    // Deprecate 'streaming.liveSyncPanicMode' configuration.
    if (config['streaming'] && 'liveSyncPanicMode' in config['streaming']) {
      Deprecate.deprecateFeature(5, 'streaming.liveSyncPanicMode', 'Please Use streaming.liveSync.panicMode instead.');
      config['streaming']['liveSync'] = config['streaming']['liveSync'] || {};
      config['streaming']['liveSync']['panicMode'] = config['streaming']['liveSyncPanicMode'];
      delete config['streaming']['liveSyncPanicMode'];
    }

    // Deprecate 'streaming.liveSyncPanicThreshold' configuration.
    if (config['streaming'] && 'liveSyncPanicThreshold' in config['streaming']) {
      Deprecate.deprecateFeature(
        5,
        'streaming.liveSyncPanicThreshold',
        'Please Use streaming.liveSync.panicThreshold instead.'
      );
      config['streaming']['liveSync'] = config['streaming']['liveSync'] || {};
      config['streaming']['liveSync']['panicThreshold'] = config['streaming']['liveSyncPanicThreshold'];
      delete config['streaming']['liveSyncPanicThreshold'];
    }

    // Deprecate 'mediaSource.sourceBufferExtraFeatures' configuration.
    if (config['mediaSource'] && 'sourceBufferExtraFeatures' in config['mediaSource']) {
      Deprecate.deprecateFeature(
        5,
        'mediaSource.sourceBufferExtraFeatures configuration',
        'Please Use mediaSource.addExtraFeaturesToSourceBuffer() instead.'
      );
      const sourceBufferExtraFeatures = config['mediaSource']['sourceBufferExtraFeatures'];
      config['mediaSource']['addExtraFeaturesToSourceBuffer'] = () => {
        return sourceBufferExtraFeatures;
      };
      delete config['mediaSource']['sourceBufferExtraFeatures'];
    }

    // Deprecate 'manifest.hls.useSafariBehaviorForLive' configuration.
    if (config['manifest'] && config['manifest']['hls'] && 'useSafariBehaviorForLive' in config['manifest']['hls']) {
      Deprecate.deprecateFeature(
        5,
        'manifest.hls.useSafariBehaviorForLive configuration',
        'Please Use liveSync config to keep on live Edge instead.'
      );
      delete config['manifest']['hls']['useSafariBehaviorForLive'];
    }

    // If lowLatencyMode is enabled, and inaccurateManifestTolerance and
    // rebufferingGoal and segmentPrefetchLimit and baseDelay and
    // autoCorrectDrift and maxDisabledTime are not specified, set
    // inaccurateManifestTolerance to 0 and rebufferingGoal to 0.01 and
    // segmentPrefetchLimit to 2 and updateIntervalSeconds to 0.1 and and
    // baseDelay to 100 and autoCorrectDrift to false and maxDisabledTime
    // to 1 by default for low latency streaming.
    if (config['streaming'] && config['streaming']['lowLatencyMode']) {
      if (config['streaming']['inaccurateManifestTolerance'] == undefined) {
        config['streaming']['inaccurateManifestTolerance'] = 0;
      }
      if (config['streaming']['rebufferingGoal'] == undefined) {
        config['streaming']['rebufferingGoal'] = 0.01;
      }
      if (config['streaming']['segmentPrefetchLimit'] == undefined) {
        config['streaming']['segmentPrefetchLimit'] = 2;
      }
      if (config['streaming']['updateIntervalSeconds'] == undefined) {
        config['streaming']['updateIntervalSeconds'] = 0.1;
      }
      if (config['streaming']['maxDisabledTime'] == undefined) {
        config['streaming']['maxDisabledTime'] = 1;
      }
      if (config['streaming']['retryParameters'] == undefined) {
        config['streaming']['retryParameters'] = {};
      }
      if (config['streaming']['retryParameters']['baseDelay'] == undefined) {
        config['streaming']['retryParameters']['baseDelay'] = 100;
      }
      if (config['manifest'] == undefined) {
        config['manifest'] = {};
      }
      if (config['manifest']['dash'] == undefined) {
        config['manifest']['dash'] = {};
      }
      if (config['manifest']['dash']['autoCorrectDrift'] == undefined) {
        config['manifest']['dash']['autoCorrectDrift'] = false;
      }
      if (config['manifest']['retryParameters'] == undefined) {
        config['manifest']['retryParameters'] = {};
      }
      if (config['manifest']['retryParameters']['baseDelay'] == undefined) {
        config['manifest']['retryParameters']['baseDelay'] = 100;
      }
      if (config['drm'] == undefined) {
        config['drm'] = {};
      }
      if (config['drm']['retryParameters'] == undefined) {
        config['drm']['retryParameters'] = {};
      }
      if (config['drm']['retryParameters']['baseDelay'] == undefined) {
        config['drm']['retryParameters']['baseDelay'] = 100;
      }
    }
    const ret = PlayerConfiguration.mergeConfigObjects(this.config_, config, this.defaultConfig_());

    this.applyConfig_();
    return ret;
  }

  // TODO(sanfeng): applyConfig_
  private applyConfig_() {
    throw new Error('Method not implemented.');
  }

  /**
   * Determines if we should use src equals, based on the the mimeType (if
   * known), the URI, and platform information.
   *
   * @param assetUri
   * @param mimeType
   * @return {boolean}
   *    |true| if the content should be loaded with src=, |false| if the content
   *    should be loaded with MediaSource.
   */
  private shouldUseSrcEquals_(assetUri: string, mimeType: string | null) {
    // If we are using a platform that does not support media source, we will
    // fall back to src= to handle all playback.
    if (!Platform.supportsMediaSource()) {
      return true;
    }

    if (mimeType) {
      // If we have a MIME type, check if the browser can play it natively.
      // This will cover both single files and native HLS.
      const mediaElement = this.video_ || Platform.anyMediaElement();
      const canPlayNatively = mediaElement.canPlayType(mimeType) != '';

      // If we can't play natively, then src= isn't an option.
      if (!canPlayNatively) {
        return false;
      }

      const canPlayMediaSource = ManifestParser.isSupported(mimeType);

      // If MediaSource isn't an option, the native option is our only chance.
      if (!canPlayMediaSource) {
        return true;
      }

      // If we land here, both are feasible.
      asserts.assert(canPlayNatively && canPlayMediaSource, 'Both native and MSE playback should be possible!');

      // We would prefer MediaSource in some cases, and src= in others.  For
      // example, Android has native HLS, but we'd prefer our own MediaSource
      // version there.

      // TODO(sanfeng): HLS
      // if (MimeUtils.isHlsType(mimeType)) {
      //   // Native HLS can be preferred on any platform via this flag:
      //   if (this.config_.streaming.preferNativeHls) {
      //     return true;
      //   }

      //   // Native FairPlay HLS can be preferred on Apple platfforms.
      //   if (
      //     Platform.isApple() &&
      //     (this.config_.drm.servers['com.apple.fps'] || this.config_.drm.servers['com.apple.fps.1_0'])
      //   ) {
      //     return this.config_.streaming.useNativeHlsForFairPlay;
      //   }

      //   // For Safari, we have an older flag which only applies to this one
      //   // browser:
      //   if (Platform.isApple()) {
      //     return this.config_.streaming.useNativeHlsOnSafari;
      //   }
      // }
      // In all other cases, we prefer MediaSource.
      return false;
    }
    // Unless there are good reasons to use src= (single-file playback or native
    // HLS), we prefer MediaSource.  So the final return value for choosing src=
    // is false.
    return false;
  }

  private async guessMimeType_(assetUri: string) {
    asserts.assert(this.networkingEngine_, 'Should have a net engine!');
    let mimeType = '';
    const retryParams = this.config_.manifest.retryParameters;
    mimeType = await NetworkingUtils.getMimeType(assetUri, this.networkingEngine_, retryParams);
    if (mimeType == 'application/x-mpegurl' && Platform.isApple()) {
      mimeType = 'application/vnd.apple.mpegurl';
    }
    return mimeType;
  }

  /**
   * Makes a fires an event corresponding to entering a state of the loading
   * process.
   * @param {string} nodeName
   * @private
   */
  makeStateChangeEvent_(nodeName: string) {
    this.dispatchEvent(Player.makeEvent_(FakeEvent.EventName.OnStateChange, new Map([['state', nodeName]])));
  }

  private onVideoError(event: Event) {
    const error = this.videoErrorToShakaError_();
    if (!error) {
      return;
    }
    this.onError_(error);
  }

  private videoErrorToShakaError_() {
    if (!this.video_) {
      return null;
    }
    asserts.assert(this.video_.error, 'Video error expected, but missing!');
    if (!this.video_.error) {
      return null;
    }
    const code = this.video_.error.code;
    if (code === 1) {
      // Ignore this error code, which should only occur when navigating away or
      // deliberately stopping playback of HTTP content.
      return null;
    }
    // Extra error information from MS Edge:
    // @ts-expect-error
    let extended = this.video_.error.msExtendedCode;
    if (extended) {
      // Convert to unsigned:
      if (extended < 0) {
        extended += Math.pow(2, 32);
      }
      // Format as hex:
      extended = extended.toString(16);
    }
    const message = this.video_.error.message;
    return new ShakaError(
      ShakaError.Severity.CRITICAL,
      ShakaError.Category.MEDIA,
      ShakaError.Code.VIDEO_ERROR,
      code,
      extended,
      message
    );
  }

  private async onError_(error: ShakaError) {
    asserts.assert(error instanceof ShakaError, 'Wrong error type!');

    // Errors dispatched after |destroy| is called are not meaningful and should
    // be safe to ignore.
    if (this.loadMode_ === Player.LoadMode.DESTROYED) {
      return;
    }
    let fireError = true;
    if (
      this.fullyLoaded_ &&
      this.manifest_ &&
      this.streamingEngine_ &&
      (error.code == ShakaError.Code.VIDEO_ERROR ||
        error.code == ShakaError.Code.MEDIA_SOURCE_OPERATION_FAILED ||
        error.code == ShakaError.Code.MEDIA_SOURCE_OPERATION_THREW ||
        error.code == ShakaError.Code.TRANSMUXING_FAILED)
    ) {
      try {
        const ret = await this.streamingEngine_.resetMediaSource();
        fireError = !ret;
      } catch (e) {
        fireError = true;
      }
    }
    if (!fireError) {
      return;
    }
    // Restore disabled variant if the player experienced a critical error.
    if (error.severity === ShakaError.Severity.CRITICAL) {
      this.restoreDisabledVariants_(false);
    }

    const eventName = FakeEvent.EventName.Error;
    const event = Player.makeEvent_(eventName, new Map().set('detail', error));
    this.dispatchEvent(event);
    if (event.defaultPrevented) {
      error.handled = true;
    }
  }

  /**
   * TODO: implement restoreDisabledVariants_
   * @param updateAbrManager
   */
  restoreDisabledVariants_(updateAbrManager = true) {}

  /**
   * Fire an event, but wait a little bit so that the immediate execution can
   * complete before the event is handled.
   *
   * @param {!util.FakeEvent} event
   * @private
   */
  private async delayDispatchEvent_(event: FakeEvent) {
    // Wait until the next interpreter cycle.
    await Promise.resolve();

    // Only dispatch the event if we are still alive.
    if (this.loadMode_ !== Player.LoadMode.DESTROYED) {
      this.dispatchEvent(event);
    }
  }

  /**
   * Create an error for when we purposely interrupt a load operation.
   *
   * @private
   */
  private createAbortLoadError_() {
    return new ShakaError(ShakaError.Severity.CRITICAL, ShakaError.Category.PLAYER, ShakaError.Code.LOAD_INTERRUPTED);
  }

  /**
   * Tries to acquire the mutex, and then returns if the operation should end
   * early due to someone else starting a mutex-acquiring operation.
   * Meant for operations that can't be interrupted midway through (e.g.
   * everything but load).
   * 尝试获取互斥锁，并在由于其他人开始获取互斥锁而导致操作提前结束时返回。
   * 适用于无法在中途中断的操作（例如除了加载之外的所有操作）。
   * @param {string} mutexIdentifier
   * @return {Promise<boolean>} endEarly If false, the calling context will
   *   need to release the mutex. endEarly 如果为false，则调用上下文将需要释放互斥锁。
   * @private
   */

  private async atomicOperationAcquireMutex_(mutexIdentifier: string) {
    const operationId = ++this.operationId_;
    await this.mutex_.acquire(mutexIdentifier);
    if (operationId !== this.operationId_) {
      this.mutex_.release();
      return true;
    }
    return false;
  }

  private static makeEvent_(type: string, data?: Map<string, Object>) {
    return new FakeEvent(type, data);
  }

  private static TYPICAL_BUFFERING_THRESHOLD_ = 0.5;

  private static supportPlugins_: Record<string, Function> = {};
}
