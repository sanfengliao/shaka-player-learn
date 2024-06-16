import { XmlNode } from '../../externs/shaka';
import { ConfigUtils } from './config_utils';
import {
  AdsConfiguration,
  CmcdConfiguration,
  CmsdConfiguration,
  DrmConfiguration,
  PlayerConfiguration as IPlayerConfiguration,
  LcevcConfiguration,
  MediaSourceConfiguration,
  StreamingConfiguration,
} from '../../externs/shaka/player';
import { NetworkingEngine } from '../net/network_engine';
import { Platform } from './platform';
import { CodecSwitchingStrategy } from '../config/codec_switching_strategy';
import { log } from '../debug/log';
import { AutoShowText } from '../config/auto_show_text';
import { SimpleAbrManager } from '../abr/simple_abr_manager';

export class PlayerConfiguration {
  /**
   * Merges the given configuration changes into the given destination.  This
   * uses the default Player configurations as the template.
   *
   * @param {shaka.extern.PlayerConfiguration} destination
   * @param {!Object} updates
   * @param {shaka.extern.PlayerConfiguration=} template
   * @return {boolean}
   * @export
   */
  static mergeConfigObjects(
    destination: IPlayerConfiguration,
    updates: Record<string, any>,
    template: IPlayerConfiguration | null = null
  ) {
    const overrides = {
      '.drm.keySystemsMapping': '',
      '.drm.servers': '',
      '.drm.clearKeys': '',
      '.drm.advanced': {
        distinctiveIdentifierRequired: false,
        persistentStateRequired: false,
        videoRobustness: '',
        audioRobustness: '',
        sessionType: '',
        serverCertificate: new Uint8Array(0),
        serverCertificateUri: '',
        individualizationServer: '',
        headers: {},
      },
    };
    return ConfigUtils.mergeConfigObjects(
      destination,
      updates,
      template || PlayerConfiguration.createDefault(),
      overrides,
      ''
    );
  }
  static createDefault(): IPlayerConfiguration {
    // This is a relatively safe default in the absence of clues from the
    // browser.  For slower connections, the default estimate may be too high.
    const bandwidthEstimate = 1e6; // 1Mbps

    let abrMaxHeight = Infinity;

    // Some browsers implement the Network Information API, which allows
    // retrieving information about a user's network connection.
    // @ts-expect-error
    if (navigator.connection) {
      // If the user has checked a box in the browser to ask it to use less
      // data, the browser will expose this intent via connection.saveData.
      // When that is true, we will default the max ABR height to 360p. Apps
      // can override this if they wish.
      //
      // The decision to use 360p was somewhat arbitrary. We needed a default
      // limit, and rather than restrict to a certain bandwidth, we decided to
      // restrict resolution. This will implicitly restrict bandwidth and
      // therefore save data. We (Shaka+Chrome) judged that:
      //   - HD would be inappropriate
      //   - If a user is asking their browser to save data, 360p it reasonable
      //   - 360p would not look terrible on small mobile device screen
      // We also found that:
      //   - YouTube's website on mobile defaults to 360p (as of 2018)
      //   - iPhone 6, in portrait mode, has a physical resolution big enough
      //     for 360p widescreen, but a little smaller than 480p widescreen
      //     (https://apple.co/2yze4es)
      // If the content's lowest resolution is above 360p, AbrManager will use
      // the lowest resolution.
      // @ts-expect-error
      if (navigator.connection.saveData) {
        abrMaxHeight = 360;
      }
    }

    // TODO(sanfeng): DRMEngine
    const drm: DrmConfiguration = {
      retryParameters: NetworkingEngine.defaultRetryParameters(),
      // These will all be verified by special cases in mergeConfigObjects_():
      servers: {}, // key is arbitrary key system ID, value must be string
      clearKeys: {}, // key is arbitrary key system ID, value must be string
      advanced: {}, // key is arbitrary key system ID, value is a record type
      delayLicenseRequestUntilPlayed: false,
      persistentSessionOnlinePlayback: false,
      persistentSessionsMetadata: [],
      initDataTransform: (initData, initDataType, drmInfo) => {
        if (Platform.isMediaKeysPolyfilled() && initDataType == 'skd') {
          const cert = drmInfo.serverCertificate;
          // const contentId = FairPlayUtils.defaultGetContentId(initData);
          // initData = FairPlayUtils.initDataTransform(initData, contentId, cert);
        }
        return initData;
      },
      logLicenseExchange: false,
      updateExpirationTime: 1,
      preferredKeySystems: [],
      keySystemsMapping: {},
      // The Xbox One browser does not detect DRM key changes signalled by a
      // change in the PSSH in media segments. We need to parse PSSH from media
      // segments to detect key changes.
      parseInbandPsshEnabled: Platform.isXboxOne(),
      minHdcpVersion: '',
      ignoreDuplicateInitData: !Platform.isTizen2(),
    };

    // The Xbox One and PS4 only support the Playready DRM, so they should
    // prefer that key system by default to improve startup performance.
    if (Platform.isXboxOne() || Platform.isPS4()) {
      drm.preferredKeySystems.push('com.microsoft.playready');
    }

    let codecSwitchingStrategy = CodecSwitchingStrategy.RELOAD;
    let multiTypeVariantsAllowed = false;
    if (Platform.supportsSmoothCodecSwitching()) {
      codecSwitchingStrategy = CodecSwitchingStrategy.SMOOTH;
      multiTypeVariantsAllowed = true;
    }

    const manifest = {
      retryParameters: NetworkingEngine.defaultRetryParameters(),
      availabilityWindowOverride: NaN,
      disableAudio: false,
      disableVideo: false,
      disableText: false,
      disableThumbnails: false,
      defaultPresentationDelay: 0,
      segmentRelativeVttTiming: false,
      raiseFatalErrorOnManifestUpdateRequestFailure: false,
      dash: {
        clockSyncUri: '',
        ignoreDrmInfo: false,
        disableXlinkProcessing: false,
        xlinkFailGracefully: false,
        ignoreMinBufferTime: false,
        autoCorrectDrift: true,
        initialSegmentLimit: 1000,
        ignoreSuggestedPresentationDelay: false,
        ignoreEmptyAdaptationSet: false,
        ignoreMaxSegmentDuration: false,
        keySystemsByURI: {
          'urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b': 'org.w3.clearkey',
          'urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e': 'org.w3.clearkey',
          'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'com.widevine.alpha',
          'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95': 'com.microsoft.playready',
          'urn:uuid:79f0049a-4098-8642-ab92-e65be0885f95': 'com.microsoft.playready',
        },
        manifestPreprocessor: PlayerConfiguration.defaultManifestPreprocessor,
        manifestPreprocessorTXml: PlayerConfiguration.defaultManifestPreprocessorTXml,
        sequenceMode: false,
        enableAudioGroups: false,
        multiTypeVariantsAllowed,
        useStreamOnceInPeriodFlattening: false,
        updatePeriod: -1,
        enableFastSwitching: true,
      },
      hls: {
        ignoreTextStreamFailures: false,
        ignoreImageStreamFailures: false,
        defaultAudioCodec: 'mp4a.40.2',
        defaultVideoCodec: 'avc1.42E01E',
        ignoreManifestProgramDateTime: false,
        ignoreManifestProgramDateTimeForTypes: [],
        mediaPlaylistFullMimeType: 'video/mp2t; codecs="avc1.42E01E, mp4a.40.2"',
        useSafariBehaviorForLive: true,
        liveSegmentsDelay: 3,
        sequenceMode: Platform.supportsSequenceMode(),
        ignoreManifestTimestampsInSegmentsMode: false,
        disableCodecGuessing: false,
        disableClosedCaptionsDetection: false,
        allowLowLatencyByteRangeOptimization: true,
      },
      mss: {
        manifestPreprocessor: PlayerConfiguration.defaultManifestPreprocessor,
        manifestPreprocessorTXml: PlayerConfiguration.defaultManifestPreprocessorTXml,
        sequenceMode: false,
        keySystemsBySystemId: {
          '9a04f079-9840-4286-ab92-e65be0885f95': 'com.microsoft.playready',
          '79f0049a-4098-8642-ab92-e65be0885f95': 'com.microsoft.playready',
        },
      },
    };

    const streaming: StreamingConfiguration = {
      retryParameters: NetworkingEngine.defaultRetryParameters(),
      // Need some operation in the callback or else closure may remove calls
      // to the function as it would be a no-op.  The operation can't just be a
      // log message, because those are stripped in the compiled build.
      failureCallback: (error) => {
        log.error('Unhandled streaming error', error);
        return ConfigUtils.referenceParametersAndReturn([error], undefined);
      },
      // When low latency streaming is enabled, rebufferingGoal will default to
      // 0.01 if not specified.
      rebufferingGoal: 2,
      bufferingGoal: 10,
      bufferBehind: 30,
      evictionGoal: 1,
      ignoreTextStreamFailures: false,
      alwaysStreamText: false,
      startAtSegmentBoundary: false,
      gapDetectionThreshold: 0.5,
      gapJumpTimerTime: 0.25 /* seconds */,
      durationBackoff: 1,
      // Offset by 5 seconds since Chromecast takes a few seconds to start
      // playing after a seek, even when buffered.
      safeSeekOffset: 5,
      stallEnabled: true,
      stallThreshold: 1 /* seconds */,
      stallSkip: 0.1 /* seconds */,
      useNativeHlsOnSafari: true,
      useNativeHlsForFairPlay: true,
      // If we are within 2 seconds of the start of a live segment, fetch the
      // previous one.  This allows for segment drift, but won't download an
      // extra segment if we aren't close to the start.
      // When low latency streaming is enabled,  inaccurateManifestTolerance
      // will default to 0 if not specified.
      inaccurateManifestTolerance: 2,
      lowLatencyMode: false,
      autoLowLatencyMode: false,
      forceHTTP: false,
      forceHTTPS: false,
      preferNativeHls: false,
      updateIntervalSeconds: 1,
      dispatchAllEmsgBoxes: false,
      observeQualityChanges: false,
      maxDisabledTime: 30,
      parsePrftBox: false,
      // When low latency streaming is enabled, segmentPrefetchLimit will
      // default to 2 if not specified.
      segmentPrefetchLimit: 0,
      prefetchAudioLanguages: [],
      disableAudioPrefetch: false,
      disableTextPrefetch: false,
      disableVideoPrefetch: false,
      liveSync: false,
      liveSyncTargetLatencyTolerance: 0.5,
      liveSyncMaxLatency: 1,
      liveSyncPlaybackRate: 1.1,
      liveSyncMinLatency: 0,
      liveSyncMinPlaybackRate: 0.95,
      liveSyncPanicMode: false,
      liveSyncPanicThreshold: 60,
      allowMediaSourceRecoveries: true,
      minTimeBetweenRecoveries: 5,
      vodDynamicPlaybackRate: false,
      vodDynamicPlaybackRateLowBufferRate: 0.95,
      vodDynamicPlaybackRateBufferRatio: 0.5,
      infiniteLiveStreamDuration: false,
      preloadNextUrlWindow: 30,
      loadTimeout: 30,
      clearDecodingCache: Platform.isPS4() || Platform.isPS5(),
      dontChooseCodecs: false,
    };

    // WebOS, Tizen, Chromecast and Hisense have long hardware pipelines
    // that respond slowly to seeking.
    // Therefore we should not seek when we detect a stall
    // on one of these platforms.  Instead, default stallSkip to 0 to force the
    // stall detector to pause and play instead.
    if (Platform.isWebOS() || Platform.isTizen() || Platform.isChromecast() || Platform.isHisense()) {
      streaming.stallSkip = 0;
    }

    // TODO(sanfeng): 实现offerline
    const offline = {};
    // const offline = {
    //   // We need to set this to a throw-away implementation for now as our
    //   // default implementation will need to reference other fields in the
    //   // config. We will set it to our intended implementation after we have
    //   // the top-level object created.
    //   // eslint-disable-next-line require-await
    //   trackSelectionCallback: async (tracks) => tracks,

    //   downloadSizeCallback: async (sizeEstimate) => {
    //     if (navigator.storage && navigator.storage.estimate) {
    //       const estimate = await navigator.storage.estimate();
    //       // Limit to 95% of quota.
    //       return estimate.usage + sizeEstimate < estimate.quota * 0.95;
    //     } else {
    //       return true;
    //     }
    //   },

    //   // Need some operation in the callback or else closure may remove calls
    //   // to the function as it would be a no-op.  The operation can't just be a
    //   // log message, because those are stripped in the compiled build.
    //   progressCallback: (content, progress) => {
    //     return ConfigUtils.referenceParametersAndReturn([content, progress], undefined);
    //   },

    //   // By default we use persistent licenses as forces errors to surface if
    //   // a platform does not support offline licenses rather than causing
    //   // unexpected behaviours when someone tries to plays downloaded content
    //   // without a persistent license.
    //   usePersistentLicense: true,

    //   numberOfParallelDownloads: 5,
    // };

    const abr = {
      enabled: true,
      useNetworkInformation: true,
      defaultBandwidthEstimate: bandwidthEstimate,
      switchInterval: 8,
      bandwidthUpgradeTarget: 0.85,
      bandwidthDowngradeTarget: 0.95,
      restrictions: {
        minWidth: 0,
        maxWidth: Infinity,
        minHeight: 0,
        maxHeight: abrMaxHeight,
        minPixels: 0,
        maxPixels: Infinity,
        minFrameRate: 0,
        maxFrameRate: Infinity,
        minBandwidth: 0,
        maxBandwidth: Infinity,
        minChannelsCount: 0,
        maxChannelsCount: Infinity,
      },
      advanced: {
        minTotalBytes: 128e3,
        minBytes: 16e3,
        fastHalfLife: 2,
        slowHalfLife: 5,
      },
      restrictToElementSize: false,
      restrictToScreenSize: false,
      ignoreDevicePixelRatio: false,
      clearBufferSwitch: false,
      safeMarginSwitch: 0,
      cacheLoadThreshold: 20,
    };

    const cmcd: CmcdConfiguration = {
      enabled: false,
      sessionId: '',
      contentId: '',
      rtpSafetyFactor: 5,
      useHeaders: false,
      includeKeys: [],
    };

    const cmsd: CmsdConfiguration = {
      enabled: true,
      applyMaximumSuggestedBitrate: true,
      estimatedThroughputWeightRatio: 0.5,
    };

    const lcevc: LcevcConfiguration = {
      enabled: false,
      dynamicPerformanceScaling: true,
      logLevel: 0,
      drawLogo: false,
    };

    const mediaSource: MediaSourceConfiguration = {
      codecSwitchingStrategy: codecSwitchingStrategy,
      addExtraFeaturesToSourceBuffer: (mimeType) => {
        return ConfigUtils.referenceParametersAndReturn([mimeType], '');
      },
      forceTransmux: false,
      insertFakeEncryptionInInit: true,
      modifyCueCallback: (cue, uri) => {
        return ConfigUtils.referenceParametersAndReturn([cue, uri], undefined);
      },
    };

    let customPlayheadTracker = false;
    let skipPlayDetection = false;
    let supportsMultipleMediaElements = true;
    if (Platform.isSmartTV()) {
      customPlayheadTracker = true;
      skipPlayDetection = true;
      supportsMultipleMediaElements = false;
    }

    const ads: AdsConfiguration = {
      customPlayheadTracker,
      skipPlayDetection,
      supportsMultipleMediaElements,
    };

    const textDisplayer = {
      captionsUpdatePeriod: 0.25,
    };

    const config: IPlayerConfiguration = {
      drm: drm,
      manifest: manifest,
      streaming: streaming,
      mediaSource: mediaSource,
      offline: {},
      abrFactory: () => new SimpleAbrManager(),
      abr: abr,
      autoShowText: AutoShowText.IF_SUBTITLES_MAY_BE_NEEDED,
      preferredAudioLanguage: '',
      preferredAudioLabel: '',
      preferredTextLanguage: '',
      preferredVariantRole: '',
      preferredTextRole: '',
      preferredAudioChannelCount: 2,
      preferredVideoHdrLevel: 'AUTO',
      preferredVideoLayout: '',
      preferredVideoLabel: '',
      preferredVideoCodecs: [],
      preferredAudioCodecs: [],
      preferForcedSubs: false,
      preferSpatialAudio: false,
      preferredDecodingAttributes: [],
      restrictions: {
        minWidth: 0,
        maxWidth: Infinity,
        minHeight: 0,
        maxHeight: Infinity,
        minPixels: 0,
        maxPixels: Infinity,
        minFrameRate: 0,
        maxFrameRate: Infinity,
        minBandwidth: 0,
        maxBandwidth: Infinity,
        minChannelsCount: 0,
        maxChannelsCount: Infinity,
      },
      playRangeStart: 0,
      playRangeEnd: Infinity,
      textDisplayer: textDisplayer,
      textDisplayFactory: () => null,
      cmcd: cmcd,
      cmsd: cmsd,
      lcevc: lcevc,
      ads: ads,
    };

    // Add this callback so that we can reference the preferred audio language
    // through the config object so that if it gets updated, we have the
    // updated value.
    // eslint-disable-next-line require-await
    // offline.trackSelectionCallback = async (tracks) => {
    //   return PlayerConfiguration.defaultTrackSelect(
    //     tracks,
    //     config.preferredAudioLanguage,
    //     config.preferredVideoHdrLevel
    //   );
    // };

    return config;
  }
  /**
   * @param element
   * @return
   */
  static defaultManifestPreprocessor(element: Element) {
    return ConfigUtils.referenceParametersAndReturn([element], element);
  }

  static defaultManifestPreprocessorTXml(element: XmlNode) {
    return ConfigUtils.referenceParametersAndReturn([element], element);
  }
}
