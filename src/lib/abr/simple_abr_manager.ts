/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AbrConfiguration, Restrictions } from '../../externs/shaka';
import { AbrManager, SwitchCallback } from '../../externs/shaka/abr_manager';
import { Variant } from '../../externs/shaka/manifest';
import { Request } from '../../externs/shaka/net';
import { asserts } from '../debug/asserts';
import { log } from '../debug/log';
import { CmsdManager } from '../util/cmsd_manager';
import { IReleasable } from '../util/i_releasable';
import { StreamUtils } from '../util/stream_utils';
import { Timer } from '../util/timer';
import { EwmaBandwidthEstimator } from './ewma_bandwidth_estimator';

/**
 * @summary
 * <p>
 * This defines the default ABR manager for the Player.  An instance of this
 * class is used when no ABR manager is given.
 * </p>
 * <p>
 * The behavior of this class is to take throughput samples using
 * segmentDownloaded to estimate the current network bandwidth.  Then it will
 * use that to choose the streams that best fit the current bandwidth.  It will
 * always pick the highest bandwidth variant it thinks can be played.
 * </p>
 * <p>
 * After initial choices are made, this class will call switchCallback() when
 * there is a better choice.  switchCallback() will not be called more than once
 * per
 * </p>
 *
 * @export
 */
export class SimpleAbrManager implements AbrManager, IReleasable {
  switch_: SwitchCallback = null as any;
  enabled_ = false;
  bandwidthEstimator_ = new EwmaBandwidthEstimator();
  onNetworkInformationChange_: (() => void) | null = null;
  config_: AbrConfiguration;
  variants_: Variant[] = [];
  playbackRate_ = 1;
  startupComplete_: boolean;
  lastTimeChosenMs_: number;
  mediaElement_: HTMLMediaElement;
  resizeObserver_: ResizeObserver | null;
  resizeObserverTimer_: Timer;
  cmsdManager_: CmsdManager | null;

  /** */
  constructor() {
    this.onNetworkInformationChange_ = null;

    // Some browsers implement the Network Information API, which allows
    // retrieving information about a user's network connection. We listen
    // to the change event to be able to make quick changes in case the type
    // of connectivity changes.
    // @ts-expect-error
    if (navigator.connection && navigator.connection.addEventListener) {
      this.onNetworkInformationChange_ = () => {
        if (this.enabled_ && this.config_.useNetworkInformation) {
          this.bandwidthEstimator_ = new EwmaBandwidthEstimator();
          if (this.config_) {
            this.bandwidthEstimator_.configure(this.config_.advanced);
          }
          const chosenVariant = this.chooseVariant();
          if (chosenVariant && navigator.onLine) {
            this.switch_(chosenVariant, this.config_.clearBufferSwitch, this.config_.safeMarginSwitch);
          }
        }
      };
      // @ts-expect-error
      navigator.connection.addEventListener('change', this.onNetworkInformationChange_);
    }

    /**
     * A filtered list of Variants to choose from.
     */
    this.variants_ = [];

    this.playbackRate_ = 1;

    this.startupComplete_ = false;

    /**
     * The last wall-clock time, in milliseconds, when streams were chosen.
     *
     */
    this.lastTimeChosenMs_ = null as any;

    this.config_ = null as any;

    this.mediaElement_ = null as any;

    this.resizeObserver_ = null;

    this.resizeObserverTimer_ = new Timer(() => {
      if (this.config_?.restrictToElementSize) {
        const chosenVariant = this.chooseVariant();
        if (chosenVariant) {
          this.switch_(chosenVariant, this.config_.clearBufferSwitch, this.config_.safeMarginSwitch);
        }
      }
    });

    this.cmsdManager_ = null;
  }
  trySuggestStreams(): void {
    throw new Error('Method not implemented.');
  }

  /**
   * @override
   * @export
   */
  stop() {
    this.switch_ = null as any;
    this.enabled_ = false;
    this.variants_ = [];
    this.playbackRate_ = 1;
    this.lastTimeChosenMs_ = null as any;
    this.mediaElement_ = null as any;

    if (this.resizeObserver_) {
      this.resizeObserver_.disconnect();
      this.resizeObserver_ = null as any;
    }

    this.resizeObserverTimer_.stop();

    this.cmsdManager_ = null;

    // Don't reset |startupComplete_|: if we've left the startup interval, we
    // can start using bandwidth estimates right away after init() is called.
  }

  /**
   * @override
   * @export
   */
  release() {
    // stop() should already have been called for unload
    // @ts-expect-error
    if (navigator.connection && navigator.connection.removeEventListener) {
      // @ts-expect-error
      navigator.connection.removeEventListener('change', this.onNetworkInformationChange_);
      this.onNetworkInformationChange_ = null;
    }

    this.resizeObserverTimer_ = null as any;
  }

  /**
   * @override
   * @export
   */
  init(switchCallback: SwitchCallback) {
    this.switch_ = switchCallback;
  }

  /**
   * @param {boolean=} preferFastSwitching
   */
  chooseVariant(preferFastSwitching = false): Variant {
    let maxHeight = Infinity;
    let maxWidth = Infinity;

    if (this.config_.restrictToScreenSize) {
      const devicePixelRatio = this.config_.ignoreDevicePixelRatio ? 1 : window.devicePixelRatio;
      maxHeight = window.screen.height * devicePixelRatio;
      maxWidth = window.screen.width * devicePixelRatio;
    }

    if (this.resizeObserver_ && this.config_.restrictToElementSize) {
      const devicePixelRatio = this.config_.ignoreDevicePixelRatio ? 1 : window.devicePixelRatio;
      maxHeight = Math.min(maxHeight, this.mediaElement_.clientHeight * devicePixelRatio);
      maxWidth = Math.min(maxWidth, this.mediaElement_.clientWidth * devicePixelRatio);
    }

    let normalVariants = this.variants_.filter((variant) => {
      return !StreamUtils.isFastSwitching(variant);
    });
    if (!normalVariants.length) {
      normalVariants = this.variants_;
    }

    let variants = normalVariants;
    if (preferFastSwitching && normalVariants.length != this.variants_.length) {
      variants = this.variants_.filter((variant) => {
        return StreamUtils.isFastSwitching(variant);
      });
    }

    // Get sorted Variants.
    let sortedVariants = this.filterAndSortVariants_(
      this.config_.restrictions,
      variants,
      /* maxHeight= */ Infinity,
      /* maxWidth= */ Infinity
    );

    if (maxHeight != Infinity || maxWidth != Infinity) {
      const resolutions = this.getResolutionList_(sortedVariants);
      for (const resolution of resolutions) {
        if (resolution.height >= maxHeight && resolution.width >= maxWidth) {
          maxHeight = resolution.height;
          maxWidth = resolution.width;
          break;
        }
      }

      sortedVariants = this.filterAndSortVariants_(this.config_.restrictions, variants, maxHeight, maxWidth);
    }

    const currentBandwidth = this.getBandwidthEstimate();

    if (variants.length && !sortedVariants.length) {
      // If we couldn't meet the ABR restrictions, we should still play
      // something.
      // These restrictions are not "hard" restrictions in the way that
      // top-level or DRM-based restrictions are.  Sort the variants without
      // restrictions and keep just the first (lowest-bandwidth) one.
      log.warning('No variants met the ABR restrictions. ' + 'Choosing a variant by lowest bandwidth.');
      sortedVariants = this.filterAndSortVariants_(
        /* restrictions= */ null,
        variants,
        /* maxHeight= */ Infinity,
        /* maxWidth= */ Infinity
      );
      sortedVariants = [sortedVariants[0]];
    }

    // Start by assuming that we will use the first Stream.
    let chosen = sortedVariants[0] || null;

    for (let i = 0; i < sortedVariants.length; i++) {
      const item = sortedVariants[i];
      const playbackRate = !isNaN(this.playbackRate_) ? Math.abs(this.playbackRate_) : 1;
      const itemBandwidth = playbackRate * item.bandwidth;
      const minBandwidth = itemBandwidth / this.config_.bandwidthDowngradeTarget;
      let next = { bandwidth: Infinity };
      for (let j = i + 1; j < sortedVariants.length; j++) {
        if (item.bandwidth != sortedVariants[j].bandwidth) {
          next = sortedVariants[j];
          break;
        }
      }
      const nextBandwidth = playbackRate * next.bandwidth;
      const maxBandwidth = nextBandwidth / this.config_.bandwidthUpgradeTarget;
      log.v2(
        'Bandwidth ranges:',
        (itemBandwidth / 1e6).toFixed(3),
        (minBandwidth / 1e6).toFixed(3),
        (maxBandwidth / 1e6).toFixed(3)
      );

      if (currentBandwidth >= minBandwidth && currentBandwidth <= maxBandwidth && chosen.bandwidth != item.bandwidth) {
        chosen = item;
      }
    }

    this.lastTimeChosenMs_ = Date.now();
    return chosen;
  }

  /**
   * @override
   * @export
   */
  enable() {
    this.enabled_ = true;
  }

  /**
   * @override
   * @export
   */
  disable() {
    this.enabled_ = false;
  }

  /**
   * @override
   * @export
   */
  segmentDownloaded(deltaTimeMs: number, numBytes: number, allowSwitch: boolean, request: Request | null = null) {
    log.v2(
      'Segment downloaded:',
      'deltaTimeMs=' + deltaTimeMs,
      'numBytes=' + numBytes,
      'lastTimeChosenMs=' + this.lastTimeChosenMs_,
      'enabled=' + this.enabled_
    );
    asserts.assert(deltaTimeMs >= 0, 'expected a non-negative duration');
    this.bandwidthEstimator_.sample(deltaTimeMs, numBytes);

    if (allowSwitch && this.lastTimeChosenMs_ != null && this.enabled_) {
      this.suggestStreams_();
    }
  }

  /**
   * @override
   * @export
   */
  getBandwidthEstimate() {
    const defaultBandwidthEstimate = this.getDefaultBandwidth_();
    const bandwidthEstimate = this.bandwidthEstimator_.getBandwidthEstimate(defaultBandwidthEstimate);
    if (this.cmsdManager_) {
      return this.cmsdManager_.getBandwidthEstimate(bandwidthEstimate);
    }
    return bandwidthEstimate;
  }

  /**
   * @override
   * @export
   */
  setVariants(variants: Variant[]) {
    this.variants_ = variants;
  }

  /**
   * @override
   * @export
   */
  playbackRateChanged(rate: number) {
    this.playbackRate_ = rate;
  }

  /**
   * @override
   * @export
   */
  setMediaElement(mediaElement: HTMLMediaElement) {
    this.mediaElement_ = mediaElement;
    if (this.resizeObserver_) {
      this.resizeObserver_.disconnect();
      this.resizeObserver_ = null;
    }
    if (this.mediaElement_ && 'ResizeObserver' in window) {
      this.resizeObserver_ = new ResizeObserver(() => {
        // Batch up resize changes before checking them.
        this.resizeObserverTimer_.tickAfter(/* seconds= */ SimpleAbrManager.RESIZE_OBSERVER_BATCH_TIME);
      });
      this.resizeObserver_.observe(this.mediaElement_);
    }
  }

  /**
   * @override
   * @export
   */
  setCmsdManager(cmsdManager: CmsdManager) {
    this.cmsdManager_ = cmsdManager;
  }

  /**
   * @override
   * @export
   */
  configure(config: AbrConfiguration) {
    this.config_ = config;
    if (this.bandwidthEstimator_ && this.config_) {
      this.bandwidthEstimator_.configure(this.config_.advanced);
    }
  }

  /**
   * Calls switch_() with the variant chosen by chooseVariant().
   *
   * @private
   */
  suggestStreams_() {
    log.v2('Suggesting Streams...');
    asserts.assert(this.lastTimeChosenMs_ != null, 'lastTimeChosenMs_ should not be null');

    if (!this.startupComplete_) {
      // Check if we've got enough data yet.
      if (!this.bandwidthEstimator_.hasGoodEstimate()) {
        log.v2('Still waiting for a good estimate...');
        return;
      }
      this.startupComplete_ = true;
    } else {
      // Check if we've left the switch interval.
      const now = Date.now();
      const delta = now - this.lastTimeChosenMs_;
      if (delta < this.config_.switchInterval * 1000) {
        log.v2('Still within switch interval...');
        return;
      }
    }

    const chosenVariant = this.chooseVariant();
    const bandwidthEstimate = this.getBandwidthEstimate();
    const currentBandwidthKbps = Math.round(bandwidthEstimate / 1000.0);

    if (chosenVariant) {
      log.debug('Calling switch_(), bandwidth=' + currentBandwidthKbps + ' kbps');
      // If any of these chosen streams are already chosen, Player will filter
      // them out before passing the choices on to StreamingEngine.
      this.switch_(chosenVariant, this.config_.clearBufferSwitch, this.config_.safeMarginSwitch);
    }
  }

  /**
   * @private
   */
  getDefaultBandwidth_() {
    let defaultBandwidthEstimate = this.config_.defaultBandwidthEstimate;

    // Some browsers implement the Network Information API, which allows
    // retrieving information about a user's network connection.  Tizen 3 has
    // NetworkInformation, but not the downlink attribute.
    // @ts-expect-error
    if (navigator.connection && navigator.connection.downlink && this.config_.useNetworkInformation) {
      // If it's available, get the bandwidth estimate from the browser (in
      // megabits per second) and use it as defaultBandwidthEstimate.
      // @ts-expect-error
      defaultBandwidthEstimate = navigator.connection.downlink * 1e6;
    }
    return defaultBandwidthEstimate;
  }

  /**
   * @param {?extern.Restrictions} restrictions
   * @param {!Array.<extern.Variant>} variants
   * @param {!number} maxHeight
   * @param {!number} maxWidth
   * @return {!Array.<extern.Variant>} variants filtered according to
   *   |restrictions| and sorted in ascending order of bandwidth.
   * @private
   */
  filterAndSortVariants_(restrictions: Restrictions | null, variants: Variant[], maxHeight: number, maxWidth: number) {
    if (this.cmsdManager_) {
      const maxBitrate = this.cmsdManager_.getMaxBitrate();
      if (maxBitrate) {
        variants = variants.filter((variant) => {
          if (!variant.bandwidth || !maxBitrate) {
            return true;
          }
          return variant.bandwidth <= maxBitrate;
        });
      }
    }

    if (restrictions) {
      variants = variants.filter((variant) => {
        // This was already checked in another scope, but the compiler doesn't
        // seem to understand that.
        asserts.assert(restrictions, 'Restrictions should exist!');

        return StreamUtils.meetsRestrictions(
          variant,
          restrictions,
          /* maxHwRes= */ { width: maxWidth, height: maxHeight }
        );
      });
    }

    return variants.sort((v1, v2) => {
      return v1.bandwidth - v2.bandwidth;
    });
  }

  /**
   * @param {!Array.<extern.Variant>} variants
   * @return {!Array.<{height: number, width: number}>}
   * @private
   */
  getResolutionList_(variants: Variant[]) {
    const resolutions = [];
    for (const variant of variants) {
      const video = variant.video;
      if (!video || !video.height || !video.width) {
        continue;
      }
      resolutions.push({
        height: video.height,
        width: video.width,
      });
    }

    return resolutions.sort((v1, v2) => {
      return v1.width - v2.width;
    });
  }

  /**
   * The amount of time, in seconds, we wait to batch up rapid resize changes.
   * This allows us to avoid multiple resize events in most cases.
   * @type {number}
   */
  static RESIZE_OBSERVER_BATCH_TIME = 1;
}
