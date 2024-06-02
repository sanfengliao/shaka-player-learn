/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { log } from '../debug/log';
import { Capabilities } from '../media/media_source_capabilities';
import { Platform } from '../util/platform';
import { polyfill } from './all';
// TODO: 完成MediaCapabilities polyfill
/**
 * @summary A polyfill to provide navigator.mediaCapabilities on all browsers.
 * This is necessary for Tizen 3, Xbox One and possibly others we have yet to
 * discover.
 * @export
 */
class MediaCapabilities {
  /**
   * Install the polyfill if needed.
   * @suppress {const}
   * @export
   */
  static install() {
    // We can enable MediaCapabilities in Android and Fuchsia devices, but not
    // in Linux devices because the implementation is buggy.
    // Since MediaCapabilities implementation is buggy in Apple browsers, we
    // should always install polyfill for Apple browsers.
    // See: https://github.com/shaka-project/shaka-player/issues/3530
    // TODO: re-evaluate MediaCapabilities in the future versions of Apple
    // Browsers.
    // Since MediaCapabilities implementation is buggy in PS5 browsers, we
    // should always install polyfill for PS5 browsers.
    // See: https://github.com/shaka-project/shaka-player/issues/3582
    // TODO: re-evaluate MediaCapabilities in the future versions of PS5
    // Browsers.
    // Since MediaCapabilities implementation does not exist in PS4 browsers, we
    // should always install polyfill.
    // Since MediaCapabilities implementation is buggy in Tizen browsers, we
    // should always install polyfill for Tizen browsers.
    // Since MediaCapabilities implementation is buggy in WebOS browsers, we
    // should always install polyfill for WebOS browsers.
    // Since MediaCapabilities implementation is buggy in EOS browsers, we
    // should always install polyfill for EOS browsers.
    // Since MediaCapabilities implementation is buggy in Hisense browsers, we
    // should always install polyfill for Hisense browsers.
    let canUseNativeMCap = true;
    if (
      Platform.isChromecast() &&
      !Platform.isAndroidCastDevice() &&
      !Platform.isFuchsiaCastDevice()
    ) {
      canUseNativeMCap = false;
    }
    if (
      Platform.isApple() ||
      Platform.isPS5() ||
      Platform.isPS4() ||
      Platform.isWebOS() ||
      Platform.isTizen() ||
      Platform.isEOS() ||
      Platform.isHisense()
    ) {
      canUseNativeMCap = false;
    }
    if (canUseNativeMCap && navigator.mediaCapabilities) {
      log.info('MediaCapabilities: Native mediaCapabilities support found.');
      return;
    }

    log.info('MediaCapabilities: install');

    if (!navigator.mediaCapabilities) {
      // @ts-ignore
      navigator.mediaCapabilities = {} as any;
    }

    // Keep the patched MediaCapabilities object from being garbage-collected in
    // Safari.
    // See https://github.com/shaka-project/shaka-player/issues/3696#issuecomment-1009472718
    MediaCapabilities.originalMcap = navigator.mediaCapabilities;

    // navigator.mediaCapabilities.decodingInfo = MediaCapabilities.decodingInfo_;
  }

  static originalMcap: any = null;

  static memoizedCanDisplayTypeRequests_: Record<string, boolean> = {};

  /**
   * @param {!MediaDecodingConfiguration} mediaDecodingConfig
   * @return {!Promise.<!MediaCapabilitiesDecodingInfo>}
   * @private
   */
  static async decodingInfo_(
    mediaDecodingConfig: MediaDecodingConfiguration
  ): Promise<MediaCapabilitiesDecodingInfo> {
    const res: MediaCapabilitiesDecodingInfo = {
      supported: false,
      powerEfficient: true,
      smooth: true,
      keySystemAccess: null,
      configuration: mediaDecodingConfig,
    } as MediaCapabilitiesDecodingInfo;

    const videoConfig = mediaDecodingConfig['video'];
    const audioConfig = mediaDecodingConfig['audio'];

    if (mediaDecodingConfig.type == 'media-source') {
      if (!Platform.supportsMediaSource()) {
        return res;
      }

      if (videoConfig) {
        const isSupported = await MediaCapabilities.checkVideoSupport_(
          videoConfig
        );
        if (!isSupported) {
          return res;
        }
      }

      if (audioConfig) {
        const isSupported = MediaCapabilities.checkAudioSupport_(audioConfig);
        if (!isSupported) {
          return res;
        }
      }
    } else if (mediaDecodingConfig.type == 'file') {
      if (videoConfig) {
        const contentType = videoConfig.contentType;
        const isSupported = Platform.supportsMediaType(contentType);
        if (!isSupported) {
          return res;
        }
      }

      if (audioConfig) {
        const contentType = audioConfig.contentType;
        const isSupported = Platform.supportsMediaType(contentType);
        if (!isSupported) {
          return res;
        }
      }
    } else {
      // Otherwise not supported.
      return res;
    }

    // @ts-ignore
    if (!mediaDecodingConfig.keySystemConfiguration) {
      // The variant is supported if it's unencrypted.
      res.supported = true;
      return res;
    } else {
      const mcapKeySystemConfig = mediaDecodingConfig.keySystemConfiguration;
      const keySystemAccess = await MediaCapabilities.checkDrmSupport_(
        videoConfig,
        audioConfig,
        mcapKeySystemConfig
      );
      if (keySystemAccess) {
        res.supported = true;
        res.keySystemAccess = keySystemAccess;
      }
    }

    return res;
  }

  /**
   * @param {!VideoConfiguration} videoConfig The 'video' field of the
   *   MediaDecodingConfiguration.
   * @return {!Promise<boolean>}
   * @private
   */
  static async checkVideoSupport_(videoConfig: VideoConfiguration) {
    // Use 'shaka.media.Capabilities.isTypeSupported' to check if
    // the stream is supported.
    // Cast platforms will additionally check canDisplayType(), which
    // accepts extended MIME type parameters.
    // See: https://github.com/shaka-project/shaka-player/issues/4726
    if (Platform.isChromecast()) {
      const isSupported = await MediaCapabilities.canCastDisplayType_(
        videoConfig
      );
      return isSupported;
    } else if (Platform.isTizen()) {
      let extendedType = videoConfig.contentType;
      if (videoConfig.width && videoConfig.height) {
        extendedType += `; width=${videoConfig.width}`;
        extendedType += `; height=${videoConfig.height}`;
      }
      if (videoConfig.framerate) {
        extendedType += `; framerate=${videoConfig.framerate}`;
      }
      if (videoConfig.bitrate) {
        extendedType += `; bitrate=${videoConfig.bitrate}`;
      }
      return Capabilities.isTypeSupported(extendedType);
    }
    return Capabilities.isTypeSupported(videoConfig.contentType);
  }

  /**
   * @param {!AudioConfiguration} audioConfig The 'audio' field of the
   *   MediaDecodingConfiguration.
   * @return {boolean}
   * @private
   */
  static checkAudioSupport_(audioConfig: AudioConfiguration) {
    let extendedType = audioConfig.contentType;
    if (Platform.isChromecast() && audioConfig.spatialRendering) {
      extendedType += '; spatialRendering=true';
    }
    return Capabilities.isTypeSupported(extendedType);
  }

  /**
   * @param {VideoConfiguration} videoConfig The 'video' field of the
   *   MediaDecodingConfiguration.
   * @param {AudioConfiguration} audioConfig The 'audio' field of the
   *   MediaDecodingConfiguration.
   * @param {!MediaCapabilitiesKeySystemConfiguration} mcapKeySystemConfig The
   *   'keySystemConfiguration' field of the MediaDecodingConfiguration.
   * @return {Promise<MediaKeySystemAccess>}
   * @private
   */
  static async checkDrmSupport_(
    videoConfig: VideoConfiguration,
    audioConfig: AudioConfiguration,
    mcapKeySystemConfig: any
  ) {
    const audioCapabilities = [];
    const videoCapabilities = [];

    if (mcapKeySystemConfig.audio) {
      const capability = {
        robustness: mcapKeySystemConfig.audio.robustness || '',
        contentType: audioConfig.contentType,
      };

      // Some Tizen devices seem to misreport AC-3 support, but correctly
      // report EC-3 support. So query EC-3 as a fallback for AC-3.
      // See https://github.com/shaka-project/shaka-player/issues/2989 for
      // details.
      if (
        Platform.isTizen() &&
        audioConfig.contentType.includes('codecs="ac-3"')
      ) {
        capability.contentType = 'audio/mp4; codecs="ec-3"';
      }

      if (mcapKeySystemConfig.audio.encryptionScheme) {
        capability.encryptionScheme =
          mcapKeySystemConfig.audio.encryptionScheme;
      }

      audioCapabilities.push(capability);
    }

    if (mcapKeySystemConfig.video) {
      const capability = {
        robustness: mcapKeySystemConfig.video.robustness || '',
        contentType: videoConfig.contentType,
      };
      if (mcapKeySystemConfig.video.encryptionScheme) {
        capability.encryptionScheme =
          mcapKeySystemConfig.video.encryptionScheme;
      }
      videoCapabilities.push(capability);
    }

    const mediaKeySystemConfig: MediaKeySystemConfiguration = {
      initDataTypes: [mcapKeySystemConfig.initDataType],
      distinctiveIdentifier: mcapKeySystemConfig.distinctiveIdentifier,
      persistentState: mcapKeySystemConfig.persistentState,
      sessionTypes: mcapKeySystemConfig.sessionTypes,
    };

    // Only add audio / video capabilities if they have valid data.
    // Otherwise the query will fail.
    if (audioCapabilities.length) {
      mediaKeySystemConfig.audioCapabilities = audioCapabilities;
    }
    if (videoCapabilities.length) {
      mediaKeySystemConfig.videoCapabilities = videoCapabilities;
    }

    const videoCodec = videoConfig ? videoConfig.contentType : '';
    const audioCodec = audioConfig ? audioConfig.contentType : '';
    const keySystem = mcapKeySystemConfig.keySystem;

    /** @type {MediaKeySystemAccess} */
    let keySystemAccess = null;
    try {
      if (
        DrmEngine.hasMediaKeySystemAccess(videoCodec, audioCodec, keySystem)
      ) {
        keySystemAccess = DrmEngine.getMediaKeySystemAccess(
          videoCodec,
          audioCodec,
          keySystem
        );
      } else {
        keySystemAccess = await navigator.requestMediaKeySystemAccess(
          mcapKeySystemConfig.keySystem,
          [mediaKeySystemConfig]
        );
        DrmEngine.setMediaKeySystemAccess(
          videoCodec,
          audioCodec,
          keySystem,
          keySystemAccess
        );
      }
    } catch (e) {
      log.info('navigator.requestMediaKeySystemAccess failed.');
    }

    return keySystemAccess;
  }

  /**
   * Checks if the given media parameters of the video or audio streams are
   * supported by the Cast platform.
   * @param {!VideoConfiguration} videoConfig The 'video' field of the
   *   MediaDecodingConfiguration.
   * @return {!Promise<boolean>} `true` when the stream can be displayed on a
   *   Cast device.
   * @private
   */
  static async canCastDisplayType_(videoConfig: VideoConfiguration) {
    if (
      !(window.cast && cast.__platform__ && cast.__platform__.canDisplayType)
    ) {
      log.warning(
        'Expected cast APIs to be available! Falling back to ' +
          'shaka.media.Capabilities.isTypeSupported() for type support.'
      );
      return Capabilities.isTypeSupported(videoConfig.contentType);
    }

    let displayType = videoConfig.contentType;
    if (videoConfig.width && videoConfig.height) {
      displayType += `; width=${videoConfig.width}; height=${videoConfig.height}`;
    }
    if (videoConfig.framerate) {
      displayType += `; framerate=${videoConfig.framerate}`;
    }
    if (videoConfig.transferFunction === 'pq') {
      // A "PQ" transfer function indicates this is an HDR-capable stream;
      // "smpte2084" is the published standard. We need to inform the platform
      // this query is specifically for HDR.
      displayType += '; eotf=smpte2084';
    }
    let result = false;
    if (displayType in MediaCapabilities.memoizedCanDisplayTypeRequests_) {
      result = MediaCapabilities.memoizedCanDisplayTypeRequests_[displayType];
    } else {
      result = await cast.__platform__.canDisplayType(displayType);
      MediaCapabilities.memoizedCanDisplayTypeRequests_[displayType] = result;
    }
    return result;
  }
}

// Install at a lower priority than MediaSource polyfill, so that we have
// MediaSource available first.
polyfill.register(MediaCapabilities.install, -1);
