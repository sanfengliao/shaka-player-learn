import { asserts } from './debug/asserts';
import { PreloadManager } from './media/preload_manager';
import { Error as ShakaError } from './util/error';
import { EventManager } from './util/event_manager';
import { FakeEvent } from './util/fake_event';
import { FakeEventTarget } from './util/fake_event_target';
import { Mutex } from './util/mutex';
import { Platform } from './util/platform';

export class Player extends FakeEventTarget {
  static LoadMode = {
    DESTROYED: 0,
    NOT_LOADED: 1,
    MEDIA_SOURCE: 2,
    SRC_EQUALS: 3,
  } as const;
  private video_: HTMLMediaElement | null = null;
  private videoContainer_: HTMLElement | null = null;
  private loadMode_: number = Player.LoadMode.NOT_LOADED;
  private assetUri_?: string;
  private mutex_ = new Mutex();
  private operationId_ = 0;
  // TODO: define mediaSourceEngine_
  private mediaSourceEngine_: any = null;

  private attachEventManager_ = new EventManager();

  private preloadNextUrl_: PreloadManager | null = null;
  private startTime_: number | undefined;
  private fullyLoaded_ = false;

  constructor() {
    super();
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
        if (
          initializeMediaSource &&
          Platform.supportsMediaSource() &&
          !this.mediaSourceEngine_
        ) {
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

  // TODO: implement initializeMediaSourceEngineInner_
  initializeMediaSourceEngineInner_() {
    throw new Error('Method not implemented.');
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
      // TODO implement adManager_ release
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
  async load(
    assetUriOrPreloader: string | PreloadManager,
    startTime?: number,
    mimeType?: string
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
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.PLAYER,
        ShakaError.Code.NO_VIDEO_ELEMENT
      );
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

    const mutexWrapOperation = async (
      operation: () => Promise<any>,
      mutexIdentifier: string
    ) => {
      try {
        await this.mutex_.acquire(mutexIdentifier);
        await detectInterruption();
        await operation();
        await detectInterruption();
        // TODO: implement
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
  private guessMimeType_(
    assetUri: string
  ): string | PromiseLike<string | undefined> | undefined {
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
    this.dispatchEvent(
      Player.makeEvent_(
        FakeEvent.EventName.OnStateChange,
        new Map([['state', nodeName]])
      )
    );
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
    // TODO: 完善一些逻辑
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
    return new ShakaError(
      ShakaError.Severity.CRITICAL,
      ShakaError.Category.PLAYER,
      ShakaError.Code.LOAD_INTERRUPTED
    );
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
