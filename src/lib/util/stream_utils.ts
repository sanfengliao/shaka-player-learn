import { Resolution, Restrictions, Track } from '../../externs/shaka';
import { DrmInfo, Manifest, Stream, Variant } from '../../externs/shaka/manifest';
import { asserts } from '../debug/asserts';
import { log } from '../debug/log';
import { DrmEngine } from '../media/drm_engtine';
import { Capabilities } from '../media/media_source_capabilities';
import { TextEngine } from '../text/text_engine';
import { Functional } from './functional';
import { LanguageUtils } from './language_utils';
import { ManifestParserUtils } from './manifest_parser_utils';
import { MimeUtils } from './mime_utils';
import { MultiMap } from './multi_map';
import { ObjectUtils } from './object_utils';
import { Platform } from './platform';

/**
 * @summary A set of utility functions for dealing with Streams and Manifests.
 * @export
 */
export class StreamUtils {
  /**
   * In case of multiple usable codecs, choose one based on lowest average
   * bandwidth and filter out the rest.
   * Also filters out variants that have too many audio channels.
   * @param manifest
   * @param preferredVideoCodecs
   * @param preferredAudioCodecs
   * @param preferredDecodingAttributes
   */
  static chooseCodecsAndFilterManifest(
    manifest: Manifest,
    preferredVideoCodecs: string[],
    preferredAudioCodecs: string[],
    preferredDecodingAttributes: string[]
  ) {
    let variants = manifest.variants;
    // To start, choose the codecs based on configured preferences if available.
    if (preferredVideoCodecs.length || preferredAudioCodecs.length) {
      variants = StreamUtils.choosePreferredCodecs(variants, preferredVideoCodecs, preferredAudioCodecs);
    }

    if (preferredDecodingAttributes.length) {
      // group variants by resolution and choose preferred variants only
      const variantsByResolutionMap = new MultiMap<Variant>();
      for (const variant of variants) {
        variantsByResolutionMap.push(String(variant.video!.width || 0), variant);
      }
      const bestVariants: Variant[] = [];
      variantsByResolutionMap.forEach((width, variantsByResolution) => {
        let highestMatch = 0;
        let matchingVariants: Variant[] = [];
        for (const variant of variantsByResolution) {
          const matchCount = preferredDecodingAttributes.filter(
            // @ts-expect-error
            (attribute) => variant.decodingInfos[0][attribute]
          ).length;
          if (matchCount > highestMatch) {
            highestMatch = matchCount;
            matchingVariants = [variant];
          } else if (matchCount == highestMatch) {
            matchingVariants.push(variant);
          }
        }
        bestVariants.push(...matchingVariants);
      });
      variants = bestVariants;
    }

    const audioStreamsSet = new Set<Stream>();
    const videoStreamsSet = new Set<Stream>();
    for (const variant of variants) {
      if (variant.audio) {
        audioStreamsSet.add(variant.audio);
      }
      if (variant.video) {
        videoStreamsSet.add(variant.video);
      }
    }

    const audioStreams = Array.from(audioStreamsSet).sort((v1, v2) => {
      return v1.bandwidth! - v2.bandwidth!;
    });
    const validAudioIds: number[] = [];
    const validAudioStreamsMap = new Map<string, Stream[]>();
    const getAudioId = (stream: Stream) => {
      return (
        stream.language +
        (stream.channelsCount || 0) +
        (stream.audioSamplingRate || 0) +
        stream.roles.join(',') +
        stream.label +
        stream.groupId +
        stream.fastSwitching
      );
    };
    for (const stream of audioStreams) {
      const groupId = getAudioId(stream);
      const validAudioStreams = validAudioStreamsMap.get(groupId) || [];
      if (!validAudioStreams.length) {
        validAudioStreams.push(stream);
        validAudioIds.push(stream.id);
      } else {
        const previousStream = validAudioStreams[validAudioStreams.length - 1];
        const previousCodec = MimeUtils.getNormalizedCodec(previousStream.codecs);
        const currentCodec = MimeUtils.getNormalizedCodec(stream.codecs);
        if (previousCodec == currentCodec) {
          if (stream.bandwidth! > previousStream.bandwidth!) {
            validAudioStreams.push(stream);
            validAudioIds.push(stream.id);
          }
        }
      }
      validAudioStreamsMap.set(groupId, validAudioStreams);
    }

    const videoStreams = Array.from(videoStreamsSet).sort((v1, v2) => {
      if (!v1.bandwidth || !v2.bandwidth) {
        return v1.width! - v2.width!;
      }
      return v1.bandwidth - v2.bandwidth;
    });

    const isChangeTypeSupported = Capabilities.isChangeTypeSupported();

    const validVideoIds: number[] = [];
    const validVideoStreamsMap = new Map<string, Stream[]>();
    const getVideoGroupId = (stream: Stream) => {
      return Math.round(stream.frameRate || 0) + (stream.hdr || '') + stream.fastSwitching;
    };
    for (const stream of videoStreams) {
      const groupId = getVideoGroupId(stream);
      const validVideoStreams = validVideoStreamsMap.get(groupId) || [];
      if (!validVideoStreams.length) {
        validVideoStreams.push(stream);
        validVideoIds.push(stream.id);
      } else {
        const previousStream = validVideoStreams[validVideoStreams.length - 1];
        if (!isChangeTypeSupported) {
          const previousCodec = MimeUtils.getNormalizedCodec(previousStream.codecs);
          const currentCodec = MimeUtils.getNormalizedCodec(stream.codecs);
          if (previousCodec !== currentCodec) {
            continue;
          }
        }
        if (stream.width! > previousStream.width! || stream.height! > previousStream.height!) {
          validVideoStreams.push(stream);
          validVideoIds.push(stream.id);
        } else if (stream.width == previousStream.width && stream.height == previousStream.height) {
          const previousCodec = MimeUtils.getNormalizedCodec(previousStream.codecs);
          const currentCodec = MimeUtils.getNormalizedCodec(stream.codecs);
          if (previousCodec == currentCodec) {
            if (stream.bandwidth! > previousStream.bandwidth!) {
              validVideoStreams.push(stream);
              validVideoIds.push(stream.id);
            }
          }
        }
      }
      validVideoStreamsMap.set(groupId, validVideoStreams);
    }

    // Filter out any variants that don't match, forcing AbrManager to choose
    // from a single video codec and a single audio codec possible.
    manifest.variants = manifest.variants.filter((variant) => {
      const audio = variant.audio;
      const video = variant.video;
      if (audio) {
        if (!validAudioIds.includes(audio.id)) {
          log.debug('Dropping Variant (better codec available)', variant);
          return false;
        }
      }
      if (video) {
        if (!validVideoIds.includes(video.id)) {
          log.debug('Dropping Variant (better codec available)', variant);
          return false;
        }
      }
      return true;
    });
  }

  /**
   * Filter the variants in |manifest| to only include the variants that meet
   * the given restrictions.
   *
   * @param manifest
   * @param restrictions
   * @param maxHwResolution
   */
  static filterByRestrictions(manifest: Manifest, restrictions: Restrictions, maxHwResolution: Resolution) {
    manifest.variants = manifest.variants.filter((variant) => {
      return StreamUtils.meetsRestrictions(variant, restrictions, maxHwResolution);
    });
  }

  /**
   * @param variant
   * @param restrictions  Configured restrictions from the user.
   * @param maxHwRes  The maximum resolution the hardware can handle.
   *   This is applied separately from user restrictions because the setting
   *   should not be easily replaced by the user's configuration.
   * @returns
   */
  static meetsRestrictions(variant: Variant, restrictions: Restrictions, maxHwRes: Resolution) {
    const inRange = (x: number, min: number, max: number) => {
      return x >= min && x <= max;
    };

    const video = variant.video;

    // |video.width| and |video.height| can be undefined, which breaks
    // the math, so make sure they are there first.
    if (video && video.width && video.height) {
      let videoWidth = video.width;
      let videoHeight = video.height;
      if (videoHeight > videoWidth) {
        // Vertical video.
        [videoWidth, videoHeight] = [videoHeight, videoWidth];
      }

      if (!inRange(videoWidth, restrictions.minWidth, Math.min(restrictions.maxWidth, maxHwRes.width))) {
        return false;
      }

      if (!inRange(videoHeight, restrictions.minHeight, Math.min(restrictions.maxHeight, maxHwRes.height))) {
        return false;
      }

      if (!inRange(video.width * video.height, restrictions.minPixels, restrictions.maxPixels)) {
        return false;
      }
    }

    // |variant.video.frameRate| can be undefined, which breaks
    // the math, so make sure they are there first.
    if (variant && variant.video && variant.video.frameRate) {
      if (!inRange(variant.video.frameRate, restrictions.minFrameRate, restrictions.maxFrameRate)) {
        return false;
      }
    }

    // |variant.audio.channelsCount| can be undefined, which breaks
    // the math, so make sure they are there first.
    if (variant && variant.audio && variant.audio.channelsCount) {
      if (!inRange(variant.audio.channelsCount, restrictions.minChannelsCount, restrictions.maxChannelsCount)) {
        return false;
      }
    }

    if (!inRange(variant.bandwidth, restrictions.minBandwidth, restrictions.maxBandwidth)) {
      return false;
    }

    return true;
  }

  /**
   * @param variants
   * @param restrictions
   * @param maxHwRes
   * @return {boolean} Whether the tracks changed.
   */
  static applyRestrictions(variants: Variant[], restrictions: Restrictions, maxHwRes: Resolution): boolean {
    let tracksChanged = false;

    for (const variant of variants) {
      const originalAllowed = variant.allowedByApplication;
      variant.allowedByApplication = StreamUtils.meetsRestrictions(variant, restrictions, maxHwRes);

      if (originalAllowed != variant.allowedByApplication) {
        tracksChanged = true;
      }
    }

    return tracksChanged;
  }

  /**
   *  Choose the codecs by configured preferred audio and video codecs.
   * @param variants
   * @param preferredVideoCodecs
   * @param preferredAudioCodecs
   */
  static choosePreferredCodecs(variants: Variant[], preferredVideoCodecs: string[], preferredAudioCodecs: string[]) {
    let subset = variants;
    for (const videoCodec of preferredVideoCodecs) {
      const filtered = subset.filter((variant) => {
        return variant.video && variant.video.codecs.startsWith(videoCodec);
      });
      if (filtered.length) {
        subset = filtered;
        break;
      }
    }

    for (const audioCodec of preferredAudioCodecs) {
      const filtered = subset.filter((variant) => {
        return variant.audio && variant.audio.codecs.startsWith(audioCodec);
      });
      if (filtered.length) {
        subset = filtered;
        break;
      }
    }
    return subset;
  }
  /**
   * Alters the given Manifest to filter out any unplayable streams.
   * @param drmEngine
   * @param manifest
   * @param preferredKeySystems
   */
  static async filterManifest(drmEngine: DrmEngine, manifest: Manifest, preferredKeySystems: string[] = []) {
    await StreamUtils.filterManifestByMediaCapabilities(
      drmEngine,
      manifest,
      manifest.offlineSessionIds.length > 0,
      preferredKeySystems
    );
    StreamUtils.filterTextStreams_(manifest);
    await StreamUtils.filterImageStreams_(manifest);
  }

  /**
   * Alters the given Manifest to filter out any unsupported text streams.
   *
   * @param manifest
   * @private
   */
  static filterTextStreams_(manifest: Manifest) {
    // Filter text streams.
    manifest.textStreams = manifest.textStreams.filter((stream) => {
      const fullMimeType = MimeUtils.getFullType(stream.mimeType, stream.codecs);
      const keep = TextEngine.isTypeSupported(fullMimeType);

      if (!keep) {
        log.debug('Dropping text stream. Is not supported by the ' + 'platform.', stream);
      }

      return keep;
    });
  }

  /**
   * Alters the given Manifest to filter out any unsupported image streams.
   *
   * @param manifest
   * @private
   */
  static async filterImageStreams_(manifest: Manifest) {
    const imageStreams = [];
    for (const stream of manifest.imageStreams) {
      let mimeType = stream.mimeType;
      if (mimeType == 'application/mp4' && stream.codecs == 'mjpg') {
        mimeType = 'image/jpg';
      }
      if (!StreamUtils.supportedImageMimeTypes_.has(mimeType)) {
        const minImage = StreamUtils.minImage_.get(mimeType);
        if (minImage) {
          // eslint-disable-next-line no-await-in-loop
          const res = await StreamUtils.isImageSupported_(minImage);
          StreamUtils.supportedImageMimeTypes_.set(mimeType, res);
        } else {
          StreamUtils.supportedImageMimeTypes_.set(mimeType, false);
        }
      }

      const keep = StreamUtils.supportedImageMimeTypes_.get(mimeType);

      if (!keep) {
        log.debug('Dropping image stream. Is not supported by the ' + 'platform.', stream);
      } else {
        imageStreams.push(stream);
      }
    }
    manifest.imageStreams = imageStreams;
  }

  /**
   * @param {string} minImage
   * @return {!Promise.<boolean>}
   * @private
   */
  static isImageSupported_(minImage: string): Promise<boolean> {
    return new Promise((resolve) => {
      const imageElement = new Image();
      imageElement.src = minImage;
      if ('decode' in imageElement) {
        imageElement
          .decode()
          .then(() => {
            resolve(true);
          })
          .catch(() => {
            resolve(false);
          });
      } else {
        // @ts-expect-error
        imageElement.onload = imageElement.onerror = () => {
          // @ts-expect-error
          resolve(imageElement.height === 2);
        };
      }
    });
  }

  static async filterManifestByMediaCapabilities(
    drmEngine: DrmEngine,
    manifest: Manifest,
    usePersistentLicenses: boolean,
    preferredKeySystems: string[]
  ) {
    asserts.assert(navigator.mediaCapabilities, 'MediaCapabilities should be valid.');
    await StreamUtils.getDecodingInfosForVariants(
      manifest.variants,
      usePersistentLicenses,
      /* srcEquals= */ false,
      preferredKeySystems
    );
    // TODO(sanfeng): DRMEngine
    let keySystem = null;

    manifest.variants = manifest.variants.filter((variant) => {
      const supported = StreamUtils.checkVariantSupported_(variant, keySystem);
      // Filter out all unsupported variants.
      if (!supported) {
        log.debug('Dropping variant - not compatible with platform', StreamUtils.getVariantSummaryString_(variant));
      }
      return supported;
    });
  }

  /**
   * Returns a string of a variant, with the attribute values of its audio
   * and/or video streams for log printing.
   * @param variant
   * @return
   * @private
   */
  static getVariantSummaryString_(variant: Variant) {
    const summaries = [];
    if (variant.audio) {
      summaries.push(StreamUtils.getStreamSummaryString_(variant.audio));
    }
    if (variant.video) {
      summaries.push(StreamUtils.getStreamSummaryString_(variant.video));
    }
    return summaries.join(', ');
  }

  /**
   * Returns a string of an audio or video stream for log printing.
   * @param stream
   * @return
   * @private
   */
  static getStreamSummaryString_(stream: Stream) {
    // Accepted parameters for Chromecast can be found (internally) at
    // go/cast-mime-params

    if (StreamUtils.isAudio(stream)) {
      return (
        'type=audio' +
        ' codecs=' +
        stream.codecs +
        ' bandwidth=' +
        stream.bandwidth +
        ' channelsCount=' +
        stream.channelsCount +
        ' audioSamplingRate=' +
        stream.audioSamplingRate
      );
    }

    if (StreamUtils.isVideo(stream)) {
      return (
        'type=video' +
        ' codecs=' +
        stream.codecs +
        ' bandwidth=' +
        stream.bandwidth +
        ' frameRate=' +
        stream.frameRate +
        ' width=' +
        stream.width +
        ' height=' +
        stream.height
      );
    }

    return 'unexpected stream type';
  }

  /**
   * Checks if the given stream is an audio stream.
   *
   * @param  stream
   * @return
   */
  static isAudio(stream: Stream) {
    const ContentType = ManifestParserUtils.ContentType;
    return stream.type == ContentType.AUDIO;
  }

  /**
   * Checks if the given stream is a video stream.
   *
   * @param {shaka.extern.Stream} stream
   * @return {boolean}
   */
  static isVideo(stream: Stream) {
    const ContentType = ManifestParserUtils.ContentType;
    return stream.type == ContentType.VIDEO;
  }

  static checkVariantSupported_(variant: Variant, keySystem: string | null = null) {
    const isXboxOne = Platform.isXboxOne();
    const ContentType = ManifestParserUtils.ContentType;
    const isFirefoxAndroid = Platform.isFirefox() && Platform.isAndroid();

    // See: https://github.com/shaka-project/shaka-player/issues/3860
    const video = variant.video;
    const videoWidth = (video && video.width) || 0;
    const videoHeight = (video && video.height) || 0;

    // See: https://github.com/shaka-project/shaka-player/issues/3380
    // Note: it makes sense to drop early
    if (
      isXboxOne &&
      video &&
      (videoWidth > 1920 || videoHeight > 1080) &&
      (video.codecs.includes('avc1.') || video.codecs.includes('avc3.'))
    ) {
      return false;
    }

    if (video) {
      let videoCodecs = StreamUtils.getCorrectVideoCodecs(video.codecs);
      // For multiplexed streams. Here we must check the audio of the
      // stream to see if it is compatible.
      if (video.codecs.includes(',')) {
        const allCodecs = video.codecs.split(',');

        videoCodecs = ManifestParserUtils.guessCodecs(ContentType.VIDEO, allCodecs);
        videoCodecs = StreamUtils.getCorrectVideoCodecs(videoCodecs);
        let audioCodecs = ManifestParserUtils.guessCodecs(ContentType.AUDIO, allCodecs);
        audioCodecs = StreamUtils.getCorrectAudioCodecs(audioCodecs, video.mimeType);

        const audioFullType = MimeUtils.getFullOrConvertedType(video.mimeType, audioCodecs, ContentType.AUDIO);

        if (!Capabilities.isTypeSupported(audioFullType)) {
          return false;
        }

        // Update the codec string with the (possibly) converted codecs.
        videoCodecs = [videoCodecs, audioCodecs].join(',');
      }

      const fullType = MimeUtils.getFullOrConvertedType(video.mimeType, videoCodecs, ContentType.VIDEO);

      if (!Capabilities.isTypeSupported(fullType)) {
        return false;
      }

      // Update the codec string with the (possibly) converted codecs.
      video.codecs = videoCodecs;
    }

    const audio = variant.audio;

    // See: https://github.com/shaka-project/shaka-player/issues/6111
    // It seems that Firefox Android reports that it supports
    // Opus + Widevine, but it is not actually supported.
    // It makes sense to drop early.
    if (isFirefoxAndroid && audio && audio.encrypted && audio.codecs.toLowerCase().includes('opus')) {
      return false;
    }

    if (audio) {
      const codecs = StreamUtils.getCorrectAudioCodecs(audio.codecs, audio.mimeType);
      const fullType = MimeUtils.getFullOrConvertedType(audio.mimeType, codecs, ContentType.AUDIO);

      if (!Capabilities.isTypeSupported(fullType)) {
        return false;
      }

      // Update the codec string with the (possibly) converted codecs.
      audio.codecs = codecs;
    }

    return variant.decodingInfos.some((decodingInfo) => {
      if (!decodingInfo.supported) {
        return false;
      }
      if (keySystem) {
        // @ts-expect-error
        const keySystemAccess = decodingInfo.keySystemAccess;
        if (keySystemAccess) {
          if (keySystemAccess.keySystem != keySystem) {
            return false;
          }
        }
      }
      return true;
    });
  }

  /**
   * Get the decodingInfo results of the variants via MediaCapabilities.
   * This should be called after the DrmEngine is created and configured, and
   * before DrmEngine sets the mediaKeys.
   * @param variants
   * @param usePersistentLicenses
   * @param srcEquals
   * @param preferredKeySystems
   */
  static async getDecodingInfosForVariants(
    variants: Variant[],
    usePersistentLicenses: boolean,
    srcEquals: boolean,
    preferredKeySystems: string[]
  ) {
    const gotDecodingInfo = variants.some((variant) => variant.decodingInfos.length);
    if (gotDecodingInfo) {
      log.debug("Already got the variants' decodingInfo.");
      return;
    }
    // Try to get preferred key systems first to avoid unneeded calls to CDM.
    // TODO(sanfeng): DRMEngine
    for (const preferredKeySystem of preferredKeySystems) {
      let keySystemSatisfied = false;
      for (const variant of variants) {
        const decodingConfigs = StreamUtils.getDecodingConfigs_(variant, usePersistentLicenses, srcEquals).filter(
          (configs) => {
            // All configs in a batch will have the same keySystem.
            const config = configs[0];
            // @ts-expect-error
            const keySystem = config.keySystemConfiguration && config.keySystemConfiguration.keySystem;
            return keySystem === preferredKeySystem;
          }
        );
        // The reason we are performing this await in a loop rather than
        // batching into a `promise.all` is performance related.
        // https://github.com/shaka-project/shaka-player/pull/4708#discussion_r1022581178
        for (const configs of decodingConfigs) {
          // eslint-disable-next-line no-await-in-loop
          await StreamUtils.getDecodingInfosForVariant_(variant, configs);
        }
        if (variant.decodingInfos.length) {
          keySystemSatisfied = true;
        }
      }
      if (keySystemSatisfied) {
        // Return if any preferred key system is already satisfied.
        return;
      }
    }

    for (const variant of variants) {
      const decodingConfigs = StreamUtils.getDecodingConfigs_(variant, usePersistentLicenses, srcEquals).filter(
        (configs) => {
          // All configs in a batch will have the same keySystem.
          const config = configs[0];
          // @ts-expect-error
          const keySystem = config.keySystemConfiguration && config.keySystemConfiguration.keySystem;
          // Avoid checking preferred systems twice.
          return !keySystem || !preferredKeySystems.includes(keySystem);
        }
      );

      // The reason we are performing this await in a loop rather than
      // batching into a `promise.all` is performance related.
      // https://github.com/shaka-project/shaka-player/pull/4708#discussion_r1022581178
      for (const configs of decodingConfigs) {
        // eslint-disable-next-line no-await-in-loop
        await StreamUtils.getDecodingInfosForVariant_(variant, configs);
      }
    }
  }

  /**
   * Queries mediaCapabilities for the decoding info for that decoding config,
   * and assigns it to the given variant.
   * If that query has been done before, instead return a cached result.
   * @param variant
   * @param decodingConfigs
   */
  static async getDecodingInfosForVariant_(variant: Variant, decodingConfigs: MediaDecodingConfiguration[]) {
    const merge = (a: MediaCapabilitiesDecodingInfo | undefined = undefined, b: MediaCapabilitiesDecodingInfo) => {
      if (!a) {
        return b;
      } else {
        const res = ObjectUtils.shallowCloneObject(a);
        res.supported = a.supported && b.supported;
        res.powerEfficient = a.powerEfficient && b.powerEfficient;
        res.smooth = a.smooth && b.smooth;
        // @ts-expect-error
        if (b.keySystemAccess && !res.keySystemAccess) {
          // @ts-expect-error
          res.keySystemAccess = b.keySystemAccess;
        }
        return res;
      }
    };

    let finalResult: MediaCapabilitiesDecodingInfo;
    const promises = [];

    for (const decodingConfig of decodingConfigs) {
      const cacheKey = StreamUtils.alphabeticalKeyOrderStringify_(decodingConfig);

      const cache = StreamUtils.decodingConfigCache_;
      if (cache[cacheKey]) {
        log.v2('Using cached results of mediaCapabilities.decodingInfo', 'for key', cacheKey);
        finalResult = merge(finalResult!, cache[cacheKey]);
      } else {
        // Do a final pass-over of the decoding config: if a given stream has
        // multiple codecs, that suggests that it switches between those codecs
        // at points of the go-through.
        // mediaCapabilities by itself will report "not supported" when you
        // put in multiple different codecs, so each has to be checked
        // individually. So check each and take the worst result, to determine
        // overall variant compatibility.
        promises.push(
          StreamUtils.checkEachDecodingConfigCombination_(decodingConfig).then((res) => {
            let acc: MediaCapabilitiesDecodingInfo | undefined;
            for (const result of res || []) {
              acc = merge(acc, result);
            }
            if (acc) {
              cache[cacheKey] = acc;
              finalResult = merge(finalResult, acc);
            }
          })
        );
      }
    }
    await Promise.all(promises);
    if (finalResult!) {
      variant.decodingInfos.push(finalResult);
    }
  }

  /**
   * @param decodingConfig
   * @return
   * @private
   */
  static checkEachDecodingConfigCombination_(decodingConfig: MediaDecodingConfiguration) {
    let videoCodecs = [''];
    if (decodingConfig.video) {
      videoCodecs = MimeUtils.getCodecs(decodingConfig.video.contentType).split(',');
    }
    let audioCodecs = [''];
    if (decodingConfig.audio) {
      audioCodecs = MimeUtils.getCodecs(decodingConfig.audio.contentType).split(',');
    }
    const promises: Promise<MediaCapabilitiesDecodingInfo>[] = [];
    for (const videoCodec of videoCodecs) {
      for (const audioCodec of audioCodecs) {
        const copy = ObjectUtils.cloneObject(decodingConfig);
        if (decodingConfig.video) {
          const mimeType = MimeUtils.getBasicType(copy.video!.contentType);
          copy.video!.contentType = MimeUtils.getFullType(mimeType, videoCodec);
        }
        if (decodingConfig.audio) {
          const mimeType = MimeUtils.getBasicType(copy.audio!.contentType);
          copy.audio!.contentType = MimeUtils.getFullType(mimeType, audioCodec);
        }
        promises.push(
          new Promise<MediaCapabilitiesDecodingInfo>((resolve, reject) => {
            navigator.mediaCapabilities
              .decodingInfo(copy)
              .then((res) => {
                resolve(res);
              })
              .catch(reject);
          })
        );
      }
    }
    return Promise.all(promises).catch((e) => {
      log.info('MediaCapabilities.decodingInfo() failed.', JSON.stringify(decodingConfig), e);
      return null;
    });
  }

  /**
   * Constructs a string out of an object, similar to the JSON.stringify method.
   * Unlike that method, this guarantees that the order of the keys is
   * alphabetical, so it can be used as a way to reliably compare two objects.
   *
   * @param {!Object} obj
   * @return {string}
   * @private
   */
  static alphabeticalKeyOrderStringify_(obj: Record<string, any>): string {
    const keys = [];
    for (const key in obj) {
      keys.push(key);
    }
    // Alphabetically sort the keys, so they will be in a reliable order.
    keys.sort();

    const terms = [];
    for (const key of keys) {
      const escapedKey = JSON.stringify(key);
      const value = obj[key];
      if (value instanceof Object) {
        const stringifiedValue = StreamUtils.alphabeticalKeyOrderStringify_(value);
        terms.push(escapedKey + ':' + stringifiedValue);
      } else {
        const escapedValue = JSON.stringify(value);
        terms.push(escapedKey + ':' + escapedValue);
      }
    }
    return '{' + terms.join(',') + '}';
  }

  /**
   * Generate a batch of MediaDecodingConfiguration objects to get the
   * decodingInfo results for each variant.
   * Each batch shares the same DRM information, and represents the various
   * fullMimeType combinations of the streams.
   * @param variant
   * @param usePersistentLicenses
   * @param srcEquals
   */
  static getDecodingConfigs_(variant: Variant, usePersistentLicenses: boolean, srcEquals: boolean) {
    const audio = variant.audio;
    const video = variant.video;

    const ContentType = ManifestParserUtils.ContentType;

    const videoConfigs: VideoConfiguration[] = [];
    const audioConfigs: AudioConfiguration[] = [];

    if (video) {
      for (const fullMimeType of video.fullMimeTypes) {
        let videoCodecs = MimeUtils.getCodecs(fullMimeType);
        // For multiplexed streams with audio+video codecs, the config should
        // have AudioConfiguration and VideoConfiguration.
        // We ignore the multiplexed audio when there is normal audio also.
        if (videoCodecs.includes(',') && !audio) {
          const allCodecs = videoCodecs.split(',');
          const baseMimeType = MimeUtils.getBasicType(fullMimeType);

          videoCodecs = ManifestParserUtils.guessCodecs(ContentType.VIDEO, allCodecs);

          let audioCodecs = ManifestParserUtils.guessCodecs(ContentType.AUDIO, allCodecs);
          audioCodecs = StreamUtils.getCorrectAudioCodecs(audioCodecs, baseMimeType);

          const audioFullType = MimeUtils.getFullOrConvertedType(baseMimeType, audioCodecs, ContentType.AUDIO);

          audioConfigs.push({
            contentType: audioFullType,
            channels: '2',
            bitrate: variant.bandwidth || 1,
            samplerate: 1,
            spatialRendering: false,
          });
        }

        videoCodecs = StreamUtils.getCorrectVideoCodecs(videoCodecs);
        const fullType = MimeUtils.getFullOrConvertedType(
          MimeUtils.getBasicType(fullMimeType),
          videoCodecs,
          ContentType.VIDEO
        );

        // VideoConfiguration
        const videoConfig: VideoConfiguration = {
          contentType: fullType,

          // NOTE: Some decoders strictly check the width and height fields and
          // won't decode smaller than 64x64.  So if we don't have this info (as
          // is the case in some of our simpler tests), assume a 64x64
          // resolution to fill in this required field for MediaCapabilities.
          //
          // This became an issue specifically on Firefox on M1 Macs.
          width: video.width || 64,
          height: video.height || 64,

          bitrate: video.bandwidth || variant.bandwidth || 1,
          // framerate must be greater than 0, otherwise the config is invalid.
          framerate: video.frameRate || 1,
        };
        if (video.hdr) {
          switch (video.hdr) {
            case 'SDR':
              videoConfig.transferFunction = 'srgb';
              break;
            case 'PQ':
              videoConfig.transferFunction = 'pq';
              break;
            case 'HLG':
              videoConfig.transferFunction = 'hlg';
              break;
          }
        }
        if (video.colorGamut) {
          videoConfig.colorGamut = video.colorGamut as ColorGamut;
        }
        videoConfigs.push(videoConfig);
      }
    }

    if (audio) {
      for (const fullMimeType of audio.fullMimeTypes) {
        const baseMimeType = MimeUtils.getBasicType(fullMimeType);
        const codecs = StreamUtils.getCorrectAudioCodecs(MimeUtils.getCodecs(fullMimeType), baseMimeType);
        const fullType = MimeUtils.getFullOrConvertedType(baseMimeType, codecs, ContentType.AUDIO);

        // AudioConfiguration
        audioConfigs.push({
          contentType: fullType,
          channels: String(audio.channelsCount || 2),
          bitrate: audio.bandwidth || variant.bandwidth || 1,
          samplerate: audio.audioSamplingRate || 1,
          spatialRendering: audio.spatialAudio,
        });
      }
    }

    const mediaDecodingConfigBatch: MediaDecodingConfiguration[] = [];

    if (videoConfigs.length == 0) {
      videoConfigs.push(null as any);
    }
    if (audioConfigs.length == 0) {
      audioConfigs.push(null as any);
    }
    for (const videoConfig of videoConfigs) {
      for (const audioConfig of audioConfigs) {
        const mediaDecodingConfig: MediaDecodingConfiguration = {
          type: srcEquals ? 'file' : 'media-source',
        };
        if (videoConfig) {
          mediaDecodingConfig.video = videoConfig;
        }
        if (audioConfig) {
          mediaDecodingConfig.audio = audioConfig;
        }
        mediaDecodingConfigBatch.push(mediaDecodingConfig);
      }
    }

    const videoDrmInfos = variant.video ? variant.video.drmInfos : [];
    const audioDrmInfos = variant.audio ? variant.audio.drmInfos : [];
    const allDrmInfos = videoDrmInfos.concat(audioDrmInfos);

    // Return a list containing the mediaDecodingConfig for unencrypted variant.
    if (!allDrmInfos.length) {
      return [mediaDecodingConfigBatch];
    }

    // TODO(sanfeng): DRMEngine
    const configs = [];
    // Get all the drm info so that we can avoid using nested loops when we
    // just need the drm info.
    const drmInfoByKeySystems = new Map<string, DrmInfo[]>();
    for (const info of allDrmInfos) {
      if (!drmInfoByKeySystems.get(info.keySystem)) {
        drmInfoByKeySystems.set(info.keySystem, []);
      }
      drmInfoByKeySystems.get(info.keySystem)!.push(info);
    }

    const persistentState = usePersistentLicenses ? 'required' : 'optional';
    const sessionTypes = usePersistentLicenses ? ['persistent-license'] : ['temporary'];

    for (const keySystem of drmInfoByKeySystems.keys()) {
      const modifiedMediaDecodingConfigBatch = [];
      for (const base of mediaDecodingConfigBatch) {
        // Create a copy of the mediaDecodingConfig.
        const config: MediaDecodingConfiguration = Object.assign({}, base);

        const drmInfos = drmInfoByKeySystems.get(keySystem)!;

        const keySystemConfig: MediaKeySystemConfiguration = {
          // @ts-expect-error
          keySystem: keySystem,
          initDataType: 'cenc',
          persistentState: persistentState,
          distinctiveIdentifier: 'optional',
          sessionTypes: sessionTypes,
        };

        for (const info of drmInfos) {
          if (info.initData && info.initData.length) {
            const initDataTypes = new Set();
            for (const initData of info.initData) {
              initDataTypes.add(initData.initDataType);
            }
            if (initDataTypes.size > 1) {
              log.v2(
                'DrmInfo contains more than one initDataType,',
                'and we use the initDataType of the first initData.',
                info
              );
            }
            // @ts-expect-error
            keySystemConfig.initDataType = info.initData[0].initDataType;
          }

          if (info.distinctiveIdentifierRequired) {
            keySystemConfig.distinctiveIdentifier = 'required';
          }
          if (info.persistentStateRequired) {
            keySystemConfig.persistentState = 'required';
          }
          if (info.sessionType) {
            keySystemConfig.sessionTypes = [info.sessionType];
          }

          if (audio) {
            // @ts-expect-error
            if (!keySystemConfig.audio) {
              // KeySystemTrackConfiguration
              // @ts-expect-error
              keySystemConfig.audio = {
                encryptionScheme: info.encryptionScheme,
                robustness: info.audioRobustness,
              };
            } else {
              // @ts-expect-error
              keySystemConfig.audio.encryptionScheme = keySystemConfig.audio.encryptionScheme || info.encryptionScheme;
              // @ts-expect-error
              keySystemConfig.audio.robustness = keySystemConfig.audio.robustness || info.audioRobustness;
            }
            // See: https://github.com/shaka-project/shaka-player/issues/4659
            // @ts-expect-error
            if (keySystemConfig.audio.robustness == '') {
              // @ts-expect-error
              delete keySystemConfig.audio.robustness;
            }
          }

          if (video) {
            // @ts-expect-error
            if (!keySystemConfig.video) {
              // KeySystemTrackConfiguration
              // @ts-expect-error
              keySystemConfig.video = {
                encryptionScheme: info.encryptionScheme,
                robustness: info.videoRobustness,
              };
            } else {
              // @ts-expect-error
              keySystemConfig.video.encryptionScheme = keySystemConfig.video.encryptionScheme || info.encryptionScheme;
              // @ts-expect-error
              keySystemConfig.video.robustness = keySystemConfig.video.robustness || info.videoRobustness;
            }
            // See: https://github.com/shaka-project/shaka-player/issues/4659
            // @ts-expect-error
            if (keySystemConfig.video.robustness == '') {
              // @ts-expect-error
              delete keySystemConfig.video.robustness;
            }
          }
        }
        // @ts-expect-error
        config.keySystemConfiguration = keySystemConfig;
        modifiedMediaDecodingConfigBatch.push(config);
      }
      configs.push(modifiedMediaDecodingConfigBatch);
    }
    return configs;
  }
  /**
   * Generates the correct audio codec for MediaDecodingConfiguration and
   * for MediaSource.isTypeSupported.
   * @param codecs
   * @param mimeType
   * @return
   */
  static getCorrectAudioCodecs(codecs: string, mimeType: string) {
    // According to RFC 6381 section 3.3, 'fLaC' is actually the correct
    // codec string. We still need to map it to 'flac', as some browsers
    // currently don't support 'fLaC', while 'flac' is supported by most
    // major browsers.
    // See https://bugs.chromium.org/p/chromium/issues/detail?id=1422728
    if (codecs.toLowerCase() == 'flac') {
      if (!Platform.isSafari()) {
        return 'flac';
      } else {
        return 'fLaC';
      }
    }

    // The same is true for 'Opus'.
    if (codecs.toLowerCase() === 'opus') {
      if (!Platform.isSafari()) {
        return 'opus';
      } else {
        if (MimeUtils.getContainerType(mimeType) == 'mp4') {
          return 'Opus';
        } else {
          return 'opus';
        }
      }
    }

    return codecs;
  }

  /**
   * Generates the correct video codec for MediaDecodingConfiguration and
   * for MediaSource.isTypeSupported.
   * @param codec
   * @return
   */
  static getCorrectVideoCodecs(codec: string) {
    if (codec.includes('avc1')) {
      // Convert avc1 codec string from RFC-4281 to RFC-6381 for
      // MediaSource.isTypeSupported
      // Example, convert avc1.66.30 to avc1.42001e (0x42 == 66 and 0x1e == 30)
      const avcdata = codec.split('.');
      if (avcdata.length == 3) {
        let result = avcdata.shift() + '.';
        result += parseInt(avcdata.shift()!, 10).toString(16);
        result += ('000' + parseInt(avcdata.shift()!, 10).toString(16)).slice(-4);
        return result;
      }
    } else if (codec == 'vp9') {
      // MediaCapabilities supports 'vp09...' codecs, but not 'vp9'. Translate
      // vp9 codec strings into 'vp09...', to allow such content to play with
      // mediaCapabilities enabled.
      // This means profile 0, level 4.1, 8-bit color.  This supports 1080p @
      // 60Hz.  See https://en.wikipedia.org/wiki/VP9#Levels
      //
      // If we don't have more detailed codec info, assume this profile and
      // level because it's high enough to likely accommodate the parameters we
      // do have, such as width and height.  If an implementation is checking
      // the profile and level very strictly, we want older VP9 content to
      // still work to some degree.  But we don't want to set a level so high
      // that it is rejected by a hardware decoder that can't handle the
      // maximum requirements of the level.
      //
      // This became an issue specifically on Firefox on M1 Macs.
      return 'vp09.00.41.08';
    }
    return codec;
  }

  /**
   * Alters the given Manifest to filter out any streams uncompatible with the
   * current variant.
   * @param currentVariant
   * @param manifest
   */
  static filterManifestByCurrentVariant(currentVariant: Variant, manifest: Manifest) {
    manifest.variants = manifest.variants.filter((variant) => {
      const audio = variant.audio;
      const video = variant.video;
      if (audio && currentVariant && currentVariant.audio) {
        if (!StreamUtils.areStreamsCompatible_(audio, currentVariant.audio)) {
          log.debug(
            'Dropping variant - not compatible with active audio',
            'active audio',
            StreamUtils.getStreamSummaryString_(currentVariant.audio),
            'variant.audio',
            StreamUtils.getStreamSummaryString_(audio)
          );
          return false;
        }
      }

      if (video && currentVariant && currentVariant.video) {
        if (!StreamUtils.areStreamsCompatible_(video, currentVariant.video)) {
          log.debug(
            'Dropping variant - not compatible with active video',
            'active video',
            StreamUtils.getStreamSummaryString_(currentVariant.video),
            'variant.video',
            StreamUtils.getStreamSummaryString_(video)
          );
          return false;
        }
      }

      return true;
    });
  }

  private static areStreamsCompatible_(s0: Stream, s1: Stream) {
    // Basic mime types and basic codecs need to match.
    // For example, we can't adapt between WebM and MP4,
    // nor can we adapt between mp4a.* to ec-3.
    // We can switch between text types on the fly,
    // so don't run this check on text.
    if (s0.mimeType != s1.mimeType) {
      return false;
    }

    if (s0.codecs.split('.')[0] != s1.codecs.split('.')[0]) {
      return false;
    }

    return true;
  }

  static variantToTrack(variant: Variant) {
    const audio = variant.audio;

    const video = variant.video;

    const audioMimeType = audio ? audio.mimeType : null;

    const videoMimeType = video ? video.mimeType : null;

    const audioCodec = audio ? audio.codecs : null;

    const videoCodec = video ? video.codecs : null;

    const codecs: string[] = [];
    if (videoCodec) {
      codecs.push(videoCodec);
    }
    if (audioCodec) {
      codecs.push(audioCodec);
    }

    const mimeTypes: string[] = [];
    if (video) {
      mimeTypes.push(video.mimeType);
    }
    if (audio) {
      mimeTypes.push(audio.mimeType);
    }

    const mimeType = mimeTypes[0] || null;

    const kinds: string[] = [];
    if (audio) {
      kinds.push(audio.kind!);
    }
    if (video) {
      kinds.push(video.kind!);
    }

    const kind = kinds[0] || null;

    const roles = new Set<string>();
    if (audio) {
      for (const role of audio.roles) {
        roles.add(role);
      }
    }
    if (video) {
      for (const role of video.roles) {
        roles.add(role);
      }
    }

    const track: Track = {
      id: variant.id,
      active: false,
      type: 'variant',
      bandwidth: variant.bandwidth,
      language: variant.language,
      label: null,
      kind: kind,
      width: null,
      height: null,
      frameRate: null,
      pixelAspectRatio: null,
      hdr: null,
      colorGamut: null,
      videoLayout: null,
      mimeType: mimeType,
      audioMimeType: audioMimeType,
      videoMimeType: videoMimeType,
      codecs: codecs.join(', '),
      audioCodec: audioCodec,
      videoCodec: videoCodec,
      primary: variant.primary,
      roles: Array.from(roles),
      audioRoles: null,
      forced: false,
      videoId: null,
      audioId: null,
      channelsCount: null,
      audioSamplingRate: null,
      spatialAudio: false,
      tilesLayout: null,
      audioBandwidth: null,
      videoBandwidth: null,
      originalVideoId: null,
      originalAudioId: null,
      originalTextId: null,
      originalImageId: null,
      accessibilityPurpose: null,
      originalLanguage: null,
    };

    if (video) {
      track.videoId = video.id;
      track.originalVideoId = video.originalId;
      track.width = video.width || null;
      track.height = video.height || null;
      track.frameRate = video.frameRate || null;
      track.pixelAspectRatio = video.pixelAspectRatio || null;
      track.videoBandwidth = video.bandwidth || null;
      track.hdr = video.hdr || null;
      track.colorGamut = video.colorGamut || null;
      track.videoLayout = video.videoLayout || null;
    }

    if (audio) {
      track.audioId = audio.id;
      track.originalAudioId = audio.originalId;
      track.channelsCount = audio.channelsCount;
      track.audioSamplingRate = audio.audioSamplingRate;
      track.audioBandwidth = audio.bandwidth || null;
      track.spatialAudio = audio.spatialAudio;
      track.label = audio.label;
      track.audioRoles = audio.roles;
      track.accessibilityPurpose = audio.accessibilityPurpose;
      track.originalLanguage = audio.originalLanguage;
    }

    return track;
  }

  /**
   * @param  stream
   * @return
   */
  static textStreamToTrack(stream: Stream) {
    const ContentType = ManifestParserUtils.ContentType;

    const track: Track = {
      id: stream.id,
      active: false,
      type: ContentType.TEXT,
      bandwidth: 0,
      language: stream.language,
      label: stream.label,
      kind: stream.kind || null,
      width: null,
      height: null,
      frameRate: null,
      pixelAspectRatio: null,
      hdr: null,
      colorGamut: null,
      videoLayout: null,
      mimeType: stream.mimeType,
      audioMimeType: null,
      videoMimeType: null,
      codecs: stream.codecs || null,
      audioCodec: null,
      videoCodec: null,
      primary: stream.primary,
      roles: stream.roles,
      audioRoles: null,
      forced: stream.forced,
      videoId: null,
      audioId: null,
      channelsCount: null,
      audioSamplingRate: null,
      spatialAudio: false,
      tilesLayout: null,
      audioBandwidth: null,
      videoBandwidth: null,
      originalVideoId: null,
      originalAudioId: null,
      originalTextId: stream.originalId,
      originalImageId: null,
      accessibilityPurpose: stream.accessibilityPurpose,
      originalLanguage: stream.originalLanguage,
    };

    return track;
  }

  /**
   * @param stream
   * @return
   */
  static imageStreamToTrack(stream: Stream) {
    const ContentType = ManifestParserUtils.ContentType;

    let width = stream.width || null;
    let height = stream.height || null;

    // The stream width and height represent the size of the entire thumbnail
    // sheet, so divide by the layout.
    let reference = null;
    // Note: segmentIndex is built by default for HLS, but not for DASH, but
    // in DASH this information comes at the stream level and not at the
    // segment level.
    if (stream.segmentIndex) {
      reference = stream.segmentIndex.get(0);
    }
    let layout = stream.tilesLayout;
    if (reference) {
      layout = reference.getTilesLayout() || layout;
    }
    if (layout && width != null) {
      width /= Number(layout.split('x')[0]);
    }
    if (layout && height != null) {
      height /= Number(layout.split('x')[1]);
    }
    // TODO: What happens if there are multiple grids, with different
    // layout sizes, inside this image stream?

    const track: Track = {
      id: stream.id,
      active: false,
      type: ContentType.IMAGE,
      bandwidth: stream.bandwidth || 0,
      language: '',
      label: null,
      kind: null,
      width,
      height,
      frameRate: null,
      pixelAspectRatio: null,
      hdr: null,
      colorGamut: null,
      videoLayout: null,
      mimeType: stream.mimeType,
      audioMimeType: null,
      videoMimeType: null,
      codecs: stream.codecs || null,
      audioCodec: null,
      videoCodec: null,
      primary: false,
      roles: [],
      audioRoles: null,
      forced: false,
      videoId: null,
      audioId: null,
      channelsCount: null,
      audioSamplingRate: null,
      spatialAudio: false,
      tilesLayout: layout || null,
      audioBandwidth: null,
      videoBandwidth: null,
      originalVideoId: null,
      originalAudioId: null,
      originalTextId: null,
      originalImageId: stream.originalId,
      accessibilityPurpose: null,
      originalLanguage: null,
    };

    return track;
  }

  /**
   * Generate and return an ID for this track, since the ID field is optional.
   *
   * @param {TextTrack|AudioTrack} html5Track
   * @return {number} The generated ID.
   */
  static html5TrackId(html5Track: TextTrack | any) {
    if (!html5Track['__shaka_id']) {
      html5Track['__shaka_id'] = StreamUtils.nextTrackId_++;
    }
    return html5Track['__shaka_id'];
  }

  /**
   * @param {TextTrack} textTrack
   * @return {shaka.extern.Track}
   */
  static html5TextTrackToTrack(textTrack: TextTrack) {
    const track = StreamUtils.html5TrackToGenericShakaTrack_(textTrack);
    track.active = textTrack.mode != 'disabled';
    track.type = 'text';
    track.originalTextId = textTrack.id;
    if (textTrack.kind == 'captions') {
      // See: https://github.com/shaka-project/shaka-player/issues/6233
      track.mimeType = 'unknown';
    }
    if (textTrack.kind == 'subtitles') {
      track.mimeType = 'text/vtt';
    }
    if (textTrack.kind) {
      track.roles = [textTrack.kind];
    }
    // @ts-expect-error
    if (textTrack.kind == 'forced') {
      track.forced = true;
    }

    return track;
  }

  /**
   * @param {AudioTrack} audioTrack
   * @return {shaka.extern.Track}
   */
  static html5AudioTrackToTrack(audioTrack: any) {
    const track = StreamUtils.html5TrackToGenericShakaTrack_(audioTrack);
    track.active = audioTrack.enabled;
    track.type = 'variant';
    track.originalAudioId = audioTrack.id;

    if (audioTrack.kind == 'main') {
      track.primary = true;
    }
    if (audioTrack.kind) {
      track.roles = [audioTrack.kind];
      track.audioRoles = [audioTrack.kind];
      track.label = audioTrack.label;
    }

    return track;
  }

  /**
   * Creates a Track object with non-type specific fields filled out.  The
   * caller is responsible for completing the Track object with any
   * type-specific information (audio or text).
   *
   * @param  html5Track
   * @return
   * @private
   */
  static html5TrackToGenericShakaTrack_(html5Track: any) {
    const language = html5Track.language;

    const track: Track = {
      id: StreamUtils.html5TrackId(html5Track),
      active: false,
      type: '',
      bandwidth: 0,
      language: LanguageUtils.normalize(language || 'und'),
      label: html5Track.label,
      kind: html5Track.kind,
      width: null,
      height: null,
      frameRate: null,
      pixelAspectRatio: null,
      hdr: null,
      colorGamut: null,
      videoLayout: null,
      mimeType: null,
      audioMimeType: null,
      videoMimeType: null,
      codecs: null,
      audioCodec: null,
      videoCodec: null,
      primary: false,
      roles: [],
      forced: false,
      audioRoles: null,
      videoId: null,
      audioId: null,
      channelsCount: null,
      audioSamplingRate: null,
      spatialAudio: false,
      tilesLayout: null,
      audioBandwidth: null,
      videoBandwidth: null,
      originalVideoId: null,
      originalAudioId: null,
      originalTextId: null,
      originalImageId: null,
      accessibilityPurpose: null,
      originalLanguage: language,
    };

    return track;
  }

  /**
   * Determines if the given variant is playable.
   * @param variant
   * @return
   */
  static isPlayable(variant: Variant) {
    return variant.allowedByApplication && variant.allowedByKeySystem && variant.disabledUntilTime == 0;
  }
  /**
   * Filters out unplayable variants.
   * @param variants
   * @returns
   */
  static getPlayableVariants(variants: Variant[]) {
    return variants.filter((variant) => {
      return StreamUtils.isPlayable(variant);
    });
  }

  /**
   * Chooses streams according to the given config.
   * Works both for Stream and Track types due to their similarities.
   * @param stream
   * @param preferredLanguage
   * @param preferredRole
   * @param preferredForced
   */
  static filterStreamsByLanguageAndRole(
    streams: Stream[] | Track[],
    preferredLanguage: string,
    preferredRole: string,
    preferredForced: boolean
  ): Stream[] | Track[] {
    let chosen = streams;

    const primary = streams.filter((stream) => {
      return stream.primary;
    }) as Stream[] | Track[];

    if (primary.length) {
      chosen = primary;
    }

    // Now reduce the set to one language.  This covers both arbitrary language
    // choice and the reduction of the "primary" stream set to one language.
    const firstLanguage = chosen.length ? chosen[0].language : '';
    chosen = chosen.filter((stream) => {
      return stream.language == firstLanguage;
    }) as Stream[] | Track[];

    // Find the streams that best match our language preference. This will
    // override previous selections.
    if (preferredLanguage) {
      const closestLocale = LanguageUtils.findClosestLocale(
        LanguageUtils.normalize(preferredLanguage),
        streams.map((stream) => stream.language)
      );

      // Only replace |chosen| if we found a locale that is close to our
      // preference.
      if (closestLocale) {
        chosen = streams.filter((stream) => {
          const locale = LanguageUtils.normalize(stream.language);
          return locale == closestLocale;
        }) as Stream[] | Track[];
      }
    }

    // Filter by forced preference
    chosen = chosen.filter((stream) => {
      return stream.forced == preferredForced;
    }) as Stream[] | Track[];

    // Now refine the choice based on role preference.
    if (preferredRole) {
      const roleMatches = StreamUtils.filterStreamsByRole_(chosen, preferredRole);
      if (roleMatches.length) {
        return roleMatches;
      } else {
        log.warning('No exact match for the text role could be found.');
      }
    } else {
      // Prefer text streams with no roles, if they exist.
      const noRoleMatches = chosen.filter((stream) => {
        return stream.roles!.length == 0;
      });
      if (noRoleMatches.length) {
        return noRoleMatches as Stream[] | Track[];
      }
    }

    // Either there was no role preference, or it could not be satisfied.
    // Choose an arbitrary role, if there are any, and filter out any other
    // roles. This ensures we never adapt between roles.

    const allRoles = chosen
      .map((stream) => {
        return stream.roles;
      })
      // @ts-expect-error
      .reduce(Functional.collapseArrays, []);

    if (!allRoles!.length) {
      return chosen;
    }

    return StreamUtils.filterStreamsByRole_(chosen, allRoles![0]);
  }

  /**
   * Filter Streams by role.
   * Works both for Stream and Track types due to their similarities.
   *
   * @param streams
   * @param preferredRole
   * @return
   * @private
   */
  static filterStreamsByRole_(streams: Stream[] | Track[], preferredRole: string) {
    return streams.filter((stream) => {
      return stream.roles!.includes(preferredRole);
    }) as Stream[] | Track[];
  }

  /**
   * Get all non-null streams in the variant as an array.
   *
   * @param variant
   * @return
   */
  static getVariantStreams(variant: Variant) {
    const streams: Stream[] = [];

    if (variant.audio) {
      streams.push(variant.audio);
    }
    if (variant.video) {
      streams.push(variant.video);
    }

    return streams;
  }

  /**
   * Indicates if some of the variant's streams are fastSwitching.
   *
   * @param variant
   * @return
   */
  static isFastSwitching(variant: Variant) {
    if (variant.audio && variant.audio.fastSwitching) {
      return true;
    }
    if (variant.video && variant.video.fastSwitching) {
      return true;
    }
    return false;
  }

  private static decodingConfigCache_: Record<string, MediaCapabilitiesDecodingInfo> = {};
  private static nextTrackId_ = 0;

  static clearDecodingConfigCache() {
    StreamUtils.decodingConfigCache_ = {};
  }

  private static DecodingAttributes = {
    SMOOTH: 'smooth',
    POWER: 'powerEfficient',
  };

  private static supportedImageMimeTypes_ = new Map<string, boolean>()
    .set('image/svg+xml', true)
    .set('image/png', true)
    .set('image/jpeg', true)
    .set('image/jpg', true);

  private static minWebPImage_ =
    'data:image/webp;base64,UklGRjoAAABXRU' +
    'JQVlA4IC4AAACyAgCdASoCAAIALmk0mk0iIiIiIgBoSygABc6WWgAA/veff/0PP8bA//LwY' +
    'AAA';

  private static minAvifImage_ =
    'data:image/avif;base64,AAAAIGZ0eXBhdm' +
    'lmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljd' +
    'AAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEA' +
    'AAABAAABGgAAAB0AAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAA' +
    'AamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAIAAAACAAAAEHBpeGkAAAAAAwgICAAAAA' +
    'xhdjFDgQ0MAAAAABNjb2xybmNseAACAAIAAYAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAA' +
    'CVtZGF0EgAKCBgANogQEAwgMg8f8D///8WfhwB8+ErK42A=';

  private static minImage_ = new Map<string, string>()
    .set('image/webp', StreamUtils.minWebPImage_)
    .set('image/avif', StreamUtils.minAvifImage_);
}
