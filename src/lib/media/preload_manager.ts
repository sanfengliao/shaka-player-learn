import {
  IManifestParser,
  ManifestParserFactory,
  ManifestParserPlayerInterface,
} from '../../externs/shaka/manifest_parser';
import { NetworkingEngine } from '../net/network_engine';
import { FakeEventTarget } from '../util/fake_event_target';
import { IDestroyable } from '../util/i_destroyable';
import { PlayerConfiguration } from '../util/player_configuration';
import { AdaptationSetCriteria, PreferenceBasedCriteria } from './adaptation_set_criteria';
import { DrmEngine } from './drm_engtine';
import { ManifestFilterer } from './manifest_filterer';
import { RegionTimeline } from './region_timeline';
import { PlayerConfiguration as IPlayerConfiguration } from '../../externs/shaka/player';
import { Manifest, Stream, Variant } from '../../externs/shaka/manifest';
import { ManifestParser } from './manifest_parser';
import { AbrManager, AbrManagerFactory } from '../../externs/shaka/abr_manager';
import { SegmentPrefetch } from './segment_prefetch';
import { QualityObserver } from './quality_observer';
import { Stats } from './stats';
import { PublicPromise } from '../util/public_promise';
import { ShakaError } from '../util/error';
import { FakeEvent } from '../util/fake_event';
import { asserts } from '../debug/asserts';
import { log } from '../debug/log';
import { ConfigUtils } from '../util/config_utils';
import { ObjectUtils } from '../util/object_utils';
import { StreamUtils } from '../util/stream_utils';
import { StreamingEngine } from './stream_engine';

export class PreloadManager extends FakeEventTarget implements IDestroyable {
  private assetUri_: string;
  private mimeType_: string | null;
  private startTime_: number | null;
  private startTimeOfLoad_: number;

  private networkingEngine_: NetworkingEngine;

  private currentAdaptationSetCriteria_: AdaptationSetCriteria | null = null;

  // TODO(sanfeng): DRMEngine
  // private createDrmEngine_: () => DrmEngine;

  private manifestFilterer_: ManifestFilterer;

  private config_: IPlayerConfiguration;

  private manifest_: Manifest | null = null;

  private manifestPlayerInterface_: ManifestParserPlayerInterface;

  private parserFactory_: ManifestParserFactory | null = null;

  private parser_: IManifestParser | null = null;

  private parserEntrusted_ = false;

  private regionTimeline_: RegionTimeline;

  private regionTimelineEntrusted_ = false;

  // TODO(sanfeng): DrmEngine
  // private drmEngine_: DrmEngine | null = null;
  // private drmEngineEntrusted_ = false;

  private abrManagerFactory_: AbrManagerFactory | null = null;

  private abrManager_: AbrManager = null as any;

  private abrManagerEntrusted_ = false;

  private segmentPrefetchById_ = new Map<number, SegmentPrefetch>();

  private segmentPrefetchEntrusted_ = false;
  private qualityObserver_: QualityObserver | null;

  private stats_ = new Stats();

  private successPromise_ = new PublicPromise();

  private eventHandoffTarget_: FakeEventTarget | null = null;

  private destroyed_ = false;

  private allowPrefetch_: boolean;

  private prefetchedVariant_: Variant | null = null;

  private allowMakeAbrManager_: boolean;

  private hasBeenAttached_ = false;
  // TODO(sanfeng): DrmEngine
  // private startTimeOfDrm_: number;

  private queuedOperations_: Function[] = [];
  private latePhaseQueuedOperations_: Function[] = [];

  constructor(
    assetUri: string,
    mimeType: string | null,
    startTimeOfLoad: number,
    startTime: number | null,
    playerInterface: PreloadManagerPlayerInterface
  ) {
    super();
    this.assetUri_ = assetUri;
    this.startTime_ = startTime;
    this.startTimeOfLoad_ = startTimeOfLoad;
    this.mimeType_ = mimeType;
    this.networkingEngine_ = playerInterface.networkingEngine;
    this.manifestFilterer_ = playerInterface.manifestFilterer;
    this.config_ = playerInterface.config;
    this.manifestPlayerInterface_ = playerInterface.manifestPlayerInterface;
    this.regionTimeline_ = playerInterface.regionTimeline;
    this.qualityObserver_ = playerInterface.qualityObserver;
    this.allowPrefetch_ = playerInterface.allowPrefetch;
    this.allowMakeAbrManager_ = playerInterface.allowMakeAbrManager;
  }

  addQueuedOperation(latePhase: boolean, callback: Function) {
    const quene = latePhase ? this.latePhaseQueuedOperations_ : this.queuedOperations_;

    if (quene) {
      quene.push(callback);
    } else {
      callback();
    }
  }

  /** Calls all late phase queued operations, and stops queueing them. */
  stopQueuingLatePhaseQueuedOperations() {
    if (this.latePhaseQueuedOperations_) {
      for (const operation of this.latePhaseQueuedOperations_) {
        operation();
      }
      this.latePhaseQueuedOperations_ = null as any;
    }
  }

  setEventHandoffTarget(target: FakeEventTarget) {
    this.eventHandoffTarget_ = target;
    this.hasBeenAttached_ = true;

    // Also call all queued operations, and stop queuing them in the future.
    if (this.queuedOperations_) {
      for (const callback of this.queuedOperations_) {
        callback();
      }
    }
    this.queuedOperations_ = null as any;
  }

  setOffsetToStartTime(offset: number) {
    if (this.startTime_ && offset) {
      this.startTime_ += offset;
    }
  }

  getStartTime() {
    return this.startTime_;
  }

  getStartTimeOfLoad() {
    return this.startTimeOfLoad_;
  }
  // TODO(sanfeng): DrmEngine
  // getStartTimeOfDrm() {}

  getMimeType() {
    return this.mimeType_;
  }
  getAssetUri() {
    return this.assetUri_;
  }

  getManifest() {
    return this.manifest_;
  }

  getParserFactory() {
    this.parserFactory_;
  }

  getCurrentAdpatationSetCriteria() {
    return this.currentAdaptationSetCriteria_;
  }

  getAbrManagerFactory() {
    return this.abrManagerFactory_;
  }

  /**
   * Gets the abr manager, if it exists. Also marks that the abr manager should
   * not be stopped if this manager is destroyed.
   * @returns
   */
  receiveAbrManager() {
    this.abrManagerEntrusted_ = true;
    return this.abrManager_;
  }

  getAbrManager() {
    return this.abrManager_;
  }

  /**
   * Gets the parser, if it exists. Also marks that the parser should not be
   * stopped if this manager is destroyed.
   */
  receiveParser() {
    this.parserEntrusted_ = true;
    return this.parser_;
  }

  getParser() {
    return this.parser_;
  }

  /**
   * Gets the region timeline, if it exists. Also marks that the timeline should
   * not be released if this manager is destroyed.
   */
  receiveRegionTimeline() {
    this.regionTimelineEntrusted_ = true;
    return this.regionTimeline_;
  }

  getRegionTimeline() {
    return this.regionTimeline_;
  }

  getQualityObserver() {
    return this.qualityObserver_;
  }

  getStats() {
    return this.stats_;
  }

  getManifestFilterer() {
    return this.manifestFilterer_;
  }

  // TODO(sanfeng): DrmEngine
  /**
   * Gets the drm engine, if it exists. Also marks that the drm engine should
   * not be destroyed if this manager is destroyed.
   */
  // receiveDrmEngine() {
  //   this.drmEngineEntrusted_ = true;
  //   return this.drmEngine_;
  // }

  // getDrmEngine() {
  //   return this.drmEngine_;
  // }
  /**
   * TODO(sanfeng) implement destroy
   */
  getPrefetchedVariant() {
    return this.prefetchedVariant_;
  }

  /**
   * Gets the SegmentPrefetch objects for the initial stream ids. Also marks
   * that those objects should not be aborted if this manager is destroyed.
   */
  receiveSegmentPrefetchesById() {
    this.segmentPrefetchEntrusted_ = true;
    return this.segmentPrefetchById_;
  }

  attachAbranager(abrManager: AbrManager, abrManagerFactory: AbrManagerFactory) {
    this.abrManager_ = abrManager;
    this.abrManagerFactory_ = abrManagerFactory;
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
   * Starts the process of loading the asset.
   * Success or failure will be measured through waitForFinish()
   */
  start() {
    (async () => {
      await Promise.resolve();
      try {
        await this.parseManifestInner_();
        this.throwIfDestroyed_();
        // TODO: DrmEngine
        // await this.initializeDrmInner_();
        // this.throwIfDestroyed_();

        await this.chooseInitialVariantInner_();
        this.throwIfDestroyed_();

        this.successPromise_.resolve();
      } catch (error) {
        this.successPromise_.reject(error);
      }
    })();
  }

  dispatchEvent(event: FakeEvent) {
    if (this.eventHandoffTarget_) {
      return this.eventHandoffTarget_.dispatchEvent(event);
    } else {
      return super.dispatchEvent(event);
    }
  }

  onError(error: ShakaError) {
    if (error.severity === ShakaError.Severity.CRITICAL) {
      this.successPromise_.reject(error);
      this.destroy();
    }

    const eventName = FakeEvent.EventName.Error;

    const event = this.makeEvent_(eventName, new Map().set('detail', error));

    this.dispatchEvent(event);
    if (event.defaultPrevented) {
      error.handled = true;
    }
  }

  private makeEvent_(name: string, data?: Map<string, any>) {
    return new FakeEvent(name, data);
  }

  /**
   * Makes a fires an event corresponding to entering a state of the loading
   * process.
   * @param name
   */
  private makeStateChangeEvent_(name: string) {
    this.dispatchEvent(new FakeEvent(FakeEvent.EventName.OnStateChange, new Map().set('state', name)));
  }

  /**
   * Throw if destroyed, to interrupt processes with a recognizable error.
   *
   */
  private throwIfDestroyed_() {
    if (this.isDestroyed()) {
      throw new ShakaError(ShakaError.Severity.CRITICAL, ShakaError.Category.PLAYER, ShakaError.Code.OBJECT_DESTROYED);
    }
  }

  /**
   * Pick and initialize a manifest parser, then have it download and parse the
   * manifest.
   */
  async parseManifestInner_() {
    this.makeStateChangeEvent_('manifest-parser');

    if (!this.parser_) {
      this.parserFactory_ = ManifestParser.getFactory(this.assetUri_, this.mimeType_);
      asserts.assert(this.parserFactory_, 'Must have manifest parser');
      this.parser_ = this.parserFactory_();

      this.parser_.configure(this.config_.manifest);
    }

    const startTime = Date.now();

    this.makeStateChangeEvent_('manifest');

    if (!this.manifest_) {
      this.manifest_ = await this.parser_.start(this.assetUri_, this.manifestPlayerInterface_);
    }

    // This event is fired after the manifest is parsed, but before any
    // filtering takes place.
    const event = this.makeEvent_(FakeEvent.EventName.ManifestParsed);
    this.dispatchEvent(event);

    if (this.manifest_.variants.length === 0) {
      throw new ShakaError(ShakaError.Severity.CRITICAL, ShakaError.Category.MANIFEST, ShakaError.Code.NO_VARIANTS);
    }
    // Make sure that all variants are either: audio-only, video-only, or
    // audio-video.
    PreloadManager.filterForAVVariants_(this.manifest_);
    const now = Date.now() / 1000;
    const delta = now - startTime;
    this.stats_.setManifestTime(delta);
  }

  /**
   * Initializes the DRM engine.
   * TODO(sanfeng): DrmEngine
   */
  // private async initializeDrmInner_() {}

  reconfigure(config: IPlayerConfiguration) {
    this.config_ = config;
  }

  configure(name: string, value: any) {
    const config = ConfigUtils.convertToConfigObject(name, value);
    PlayerConfiguration.mergeConfigObjects(this.config_, config);
  }

  getConfiguration() {
    return ObjectUtils.cloneObject(this.config_);
  }

  /**
   * Performs a final filtering of the manifest, and chooses the initial
   * variant.
   */
  private chooseInitialVariantInner_() {
    if (!this.manifest_) {
      asserts.assert(this.manifest_, 'The manifest should already be parsed.');
      return;
    }
    // This step does not have any associated events, as it is only part of the
    // "load" state in the old state graph.

    if (!this.currentAdaptationSetCriteria_) {
      // Copy preferred languages from the config again, in case the config was
      // changed between construction and playback.
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
    }

    // Make the ABR manager.
    if (this.allowMakeAbrManager_) {
      const abrFactory = this.config_.abrFactory;
      this.abrManagerFactory_ = abrFactory;
      this.abrManager_ = abrFactory();
      this.abrManager_.configure(this.config_.abr);
    }

    if (this.allowPrefetch_) {
      const isLive = this.manifest_.presentationTimeline.isLive();
      // Prefetch segments for the predicted first variant.
      // We start these here, but don't wait for them; it's okay to start the
      // full load process while the segments are being prefetched.
      const playableVariants = StreamUtils.getPlayableVariants(this.manifest_.variants);

      const adaptationSet = this.currentAdaptationSetCriteria_.create(playableVariants);

      // Guess what the first variant will be, based on a SimpleAbrManager.
      this.abrManager_.configure(this.config_.abr);
      this.abrManager_.setVariants(Array.from(adaptationSet.values()));
      const variant = this.abrManager_.chooseVariant(/* preferFastSwitching= */ true);

      if (variant) {
        this.prefetchedVariant_ = variant;
        if (variant.video) {
          this.makePrefetchForStream_(variant.video, isLive);
        }
        if (variant.audio) {
          this.makePrefetchForStream_(variant.audio, isLive);
        }
      }
    }
  }

  private async makePrefetchForStream_(stream: Stream, isLive: boolean) {
    // Use the prefetch limit from the config if this is set, otherwise use 2.
    const prefetchLimit = this.config_.streaming.segmentPrefetchLimit || 2;

    const prefetch = new SegmentPrefetch(prefetchLimit, stream, (reference, stream, streamCallback) => {
      return StreamingEngine.dispatchFetch(
        reference,
        stream,
        streamCallback || null,
        this.config_.streaming.retryParameters,
        this.networkingEngine_
      );
    });
    this.segmentPrefetchById_.set(stream.id, prefetch);

    await stream.createSegmentIndex();

    const startTime = this.startTime_ || 0;

    const prefetchSegmentIterator = stream.segmentIndex!.getIteratorForTime(startTime);
    let prefetchSegment = prefetchSegmentIterator ? prefetchSegmentIterator.current() : null;

    if (!prefetchSegment) {
      // If we can't get a segment at the desired spot, at least get a segment,
      // so we can get the init segment.
      prefetchSegment = stream.segmentIndex!.get(0);
    }

    if (prefetchSegment) {
      if (isLive) {
        // Preload only the init segment for Live
        if (prefetchSegment.initSegmentReference) {
          prefetch.prefetchInitSegment(prefetchSegment.initSegmentReference);
        }
      } else {
        // Preload a segment, too... either the first segment, or the segment
        // that corresponds with this.startTime_, as appropriate.
        // Note: this method also preload the init segment
        prefetch.prefetchSegmentsByTime(prefetchSegment.startTime);
      }
    }
  }

  /**
   * Waits for the loading to be finished (or to fail with an error).
   */
  waitForFinish(): Promise<void> {
    return this.successPromise_ as any;
  }

  async destroy(): Promise<void> {
    this.destroyed_ = true;
    if (this.parser_ && !this.parserEntrusted_) {
      await this.parser_.stop();
    }
    if (this.abrManager_ && !this.abrManagerEntrusted_) {
      await this.abrManager_.stop();
    }
    if (this.regionTimeline_ && !this.regionTimelineEntrusted_) {
      this.regionTimeline_.release();
    }
    // TODO(sanfeng): DrmEngine
    // if (this.drmEngine_ && !this.drmEngineEntrusted_) {
    //   await this.drmEngine_.destroy();
    // }
    if (this.segmentPrefetchById_.size > 0 && !this.segmentPrefetchEntrusted_) {
      for (const segmentPrefetch of this.segmentPrefetchById_.values()) {
        segmentPrefetch.clearAll();
      }
    }
    // this.eventHandoffTarget_ is not unset, so that events and errors fired
    // after the preload manager is destroyed will still be routed to the
    // player, if it was once linked up.
  }

  isDestroyed() {
    return this.destroyed_;
  }

  hasBeenAttached() {
    return this.hasBeenAttached_;
  }

  /**
   * Take a series of variants and ensure that they only contain one type of
   * variant. The different options are:
   *  1. Audio-Video
   *  2. Audio-Only
   *  3. Video-Only
   *
   * A manifest can only contain a single type because once we initialize media
   * source to expect specific streams, it must always have content for those
   * streams. If we were to start with audio+video and switch to an audio-only
   * variant, media source would block waiting for video content.
   *
   * @param manifest
   */
  static filterForAVVariants_(manifest: Manifest) {
    const isAVVariant = (variant: Variant) => {
      // Audio-video variants may include both streams separately or may be
      // single multiplexed streams with multiple codecs.
      return (variant.video && variant.audio) || (variant.video && variant.video.codecs.includes(','));
    };
    if (manifest.variants.some(isAVVariant)) {
      log.debug('Found variant with audio and video content, ' + 'so filtering out audio-only content.');
      manifest.variants = manifest.variants.filter(isAVVariant);
    }
  }
}

export interface PreloadManagerPlayerInterface {
  config: IPlayerConfiguration;
  manifestPlayerInterface: ManifestParserPlayerInterface;
  regionTimeline: RegionTimeline;
  createDrmEngine: () => DrmEngine;
  networkingEngine: NetworkingEngine;
  manifestFilterer: ManifestFilterer;
  allowPrefetch: boolean;
  allowMakeAbrManager: boolean;
  qualityObserver: QualityObserver | null;
}
