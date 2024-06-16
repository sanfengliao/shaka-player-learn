import { asserts } from './debug/asserts';
import { PreloadManager } from './media/preload_manager';
import { NetworkingEngine } from './net/network_engine';
import { ShakaError as ShakaError } from './util/error';
import { EventManager } from './util/event_manager';
import { FakeEvent } from './util/fake_event';
import { FakeEventTarget } from './util/fake_event_target';
import { Mutex } from './util/mutex';
import { Platform } from './util/platform';
import { ID3Metadata, PlayerConfiguration as IPlayerConfiguration, MetadataFrame } from '../externs/shaka/player';
import { PlayerConfiguration } from './util/player_configuration';
import { log } from './debug/log';
import { Manifest } from '../externs/shaka/manifest';
import { MediaSourceEngine, OnMetadata } from './media/media_source_engine';
import { TextDisplayer } from '../externs/shaka/text';
import { IDestroyable } from './util/i_destroyable';
import { Playhead } from './media/playhead';
import { PlayheadObserverManager } from './media/playhead_observer';

export class Player extends FakeEventTarget implements IDestroyable {
  static LoadMode = {
    DESTROYED: 0,
    NOT_LOADED: 1,
    MEDIA_SOURCE: 2,
    SRC_EQUALS: 3,
  } as const;
  private video_: HTMLMediaElement;
  private videoContainer_: HTMLElement;
  private loadMode_: number;
  private assetUri_?: string;
  private mutex_: Mutex;
  private operationId_: number;

  private attachEventManager_: EventManager;
  private preloadNextUrl_: PreloadManager | null = null;
  private startTime_: number | undefined;
  private fullyLoaded_ = false;

  private networkingEngine_: NetworkingEngine;

  private config_: IPlayerConfiguration;

  private manifest_: Manifest;

  private isTextVisible_: boolean;

  private globalEventManager_: EventManager;
  private loadEventManager_: EventManager;
  private trickPlayEventManager_: EventManager;
  private mediaSourceEngine_: MediaSourceEngine;

  private playhead_: Playhead;

  private playHeadObservers_: PlayheadObserverManager;

  constructor() {
    super();
    this.loadMode_ = Player.LoadMode.NOT_LOADED;

    this.config_ = this.defaultConfig_();

    this.video_ = null as any;
    this.videoContainer_ = null as any;

    /**
     * Since we may not always have a text displayer created (e.g. before |load|
     * is called), we need to track what text visibility SHOULD be so that we
     * can ensure that when we create the text displayer. When we create our
     * text displayer, we will use this to show (or not show) text as per the
     * user's requests.
     * TODO(sanfeng): TextEngine
     */
    this.isTextVisible_ = false;

    /**
     * For listeners scoped to the lifetime of the Player instance.
     */
    this.globalEventManager_ = new EventManager();

    /**
     * For listeners scoped to the lifetime of the media element attachment.
     */
    this.attachEventManager_ = new EventManager();

    /**
     * For listeners scoped to the lifetime of the loaded content.
     */
    this.loadEventManager_ = new EventManager();

    /**
     *  For listeners scoped to the lifetime of the loaded content.
     */
    this.trickPlayEventManager_ = new EventManager();

    /**
     * For listeners scoped to the lifetime of the ad manager.
     * TODO(sanfeng): AdManager
     */
    // this.adManagerEventManager_ = new EventManager();

    this.networkingEngine_ = null as any;
    /**
     * TODO(sanfeng): DrmEngine
     */
    // this.drmEngine_ = null as any;

    this.mediaSourceEngine_ = null as any;

    this.playhead_ = null as any;

    /**
     * Incremented whenever a top-level operation (load, attach, etc) is
     * performed.
     * Used to determine if a load operation has been interrupted.
     */
    this.operationId_ = 0;

    this.mutex_ = new Mutex();

    /**
     * The playhead observers are used to monitor the position of the playhead
     * and some other source of data (e.g. buffered content), and raise events.
     *
     */
    this.playHeadObservers_ = null as any;
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

  async initializeMediaSourceEngineInner_() {
    asserts.assert(
      Platform.supportsMediaSource(),
      'We should not be initializing media source on a platform that ' + 'does not support media source.'
    );
    asserts.assert(this.video_, 'We should have a media element when initializing media source.');
    asserts.assert(this.mediaSourceEngine_ == null, 'We should not have a media source engine yet.');
    this.makeStateChangeEvent_('media-source');

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
   * @param {!shaka.extern.TextDisplayer} textDisplayer
   * @param {!function(!Array.<shaka.extern.ID3Metadata>, number, ?number)}
   *  onMetadata
   * @param {shaka.lcevc.Dec} lcevcDec
   *
   * @return {!shaka.media.MediaSourceEngine}
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
        this.video_ = null;
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
   * @param {boolean=} initializeMediaSource
   * @param {boolean=} keepAdManager
   * @return {!Promise}
   * @export
   */
  async unload(initializeMediaSource = true, keepAdManager = false) {
    throw new Error('Method not implemented.');
  }
  /**
   * TODO: support PreloadManager
   * Loads a new stream.
   * If another stream was already playing, first unloads that stream.
   *
   * @param {string|shaka.media.PreloadManager} assetUriOrPreloader
   * @param {?number=} startTime
   *    When <code>startTime</code> is <code>null</code> or
   *    <code>undefined</code>, playback will start at the default start time (0
   *    for VOD and liveEdge for LIVE).

   * @return {!Promise}
   * @export
   */
  async load(assetUriOrPreloader: string | PreloadManager, startTime?: number, mimeType?: string) {
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
        // TODO: PreloadManager
        // if (preloadManager && this.config_) {
        //   preloadManager.reconfigure(this.config_);
        // }
      } finally {
        this.mutex_.release();
      }
    };

    try {
      if (startTime == null && preloadManager) {
        startTime = preloadManager.getStartTime();
      }

      this.startTime_ = startTime;
      this.fullyLoaded_ = false;
      this.dispatchEvent(Player.makeEvent_(FakeEvent.EventName.Loading));

      if (preloadManager) {
        mimeType = preloadManager.getMimeType();
      } else if (!mimeType) {
        await mutexWrapOperation(async () => {
          mimeType = await this.guessMimeType_(assetUri);
        }, 'guessMimeType_');
      }
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
  private guessMimeType_(assetUri: string): string | PromiseLike<string | undefined> | undefined {
    asserts.assert(this.networkingEngine_, 'Should have a net engine!');
    let mimeType = '';
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
    // TODO(sanfeng): 完善一些逻辑
    // if (this.fullyLoaded_ && this.manifest_ && this.streamingEngine_ &&
    //   (error.code == shaka.util.Error.Code.VIDEO_ERROR ||
    //   error.code == shaka.util.Error.Code.MEDIA_SOURCE_OPERATION_FAILED ||
    //   error.code == shaka.util.Error.Code.MEDIA_SOURCE_OPERATION_THREW ||
    //   error.code == shaka.util.Error.Code.TRANSMUXING_FAILED)) {
    // try {
    //   const ret = await this.streamingEngine_.resetMediaSource();
    //   fireError = !ret;
    // } catch (e) {
    //   fireError = true;
    // }
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
}
