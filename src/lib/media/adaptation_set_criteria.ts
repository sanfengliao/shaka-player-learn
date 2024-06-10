import { Variant } from '../../externs/shaka/manifest';
import { CodecSwitchingStrategy } from '../config/codec_switching_strategy';
import { log } from '../debug/log';
import { LanguageUtils } from '../util/language_utils';
import { AdaptationSet } from './adaptation_set';
import { Capabilities } from './media_source_capabilities';

/**
 * An adaptation set criteria is a unit of logic that can take a set of
 * variants and return a subset of variants that should (and can) be
 * adapted between.
 */
export interface AdaptationSetCriteria {
  create(variants: Variant[]): AdaptationSet;
}

export class PreferenceBasedCriteria implements AdaptationSetCriteria {
  private language_: string;
  private role_: string;
  private channelCount_: number;
  private hdrLevel_: string;
  private spatialAudio_: boolean;
  private videoLayout_: string;
  private audioLabel_: string;
  private videoLabel_: string;
  private codecSwitchingStrategy_: CodecSwitchingStrategy;
  private enableAudioGroups_: boolean;
  constructor(
    language: string,
    role: string,
    channelCount: number,
    hdrLevel: string,
    spatialAudio: boolean,
    videoLayout: string,
    audioLabel = '',
    videoLabel = '',
    codecSwitchingStrategy = CodecSwitchingStrategy.RELOAD,
    enableAudioGroups = false
  ) {
    this.language_ = language;
    this.role_ = role;
    this.channelCount_ = channelCount;
    this.hdrLevel_ = hdrLevel;
    this.spatialAudio_ = spatialAudio;
    this.videoLayout_ = videoLayout;
    this.audioLabel_ = audioLabel;
    this.videoLabel_ = videoLabel;
    this.codecSwitchingStrategy_ = codecSwitchingStrategy;
    this.enableAudioGroups_ = enableAudioGroups;
  }
  create(variants: Variant[]): AdaptationSet {
    let current: Variant[] = [];

    const byLanguage = PreferenceBasedCriteria.filterByLanguage_(variants, this.language_);
    const byPrimary = variants.filter((variant) => variant.primary);

    if (byLanguage.length) {
      current = byLanguage;
    } else if (byPrimary.length) {
      current = byPrimary;
    } else {
      current = variants;
    }

    // Now refine the choice based on role preference.  Even the empty string
    // works here, and will match variants without any roles.
    const byRole = PreferenceBasedCriteria.filterVariantsByRole_(current, this.role_);
    if (byRole.length) {
      current = byRole;
    } else {
      log.warning('No exact match for variant role could be found.');
    }

    if (this.videoLayout_) {
      const byVideoLayout = PreferenceBasedCriteria.filterVariantsByVideoLayout_(current, this.videoLayout_);
      if (byVideoLayout.length) {
        current = byVideoLayout;
      } else {
        log.warning('No exact match for the video layout could be found.');
      }
    }

    if (this.hdrLevel_) {
      const byHdrLevel = PreferenceBasedCriteria.filterVariantsByHDRLevel_(current, this.hdrLevel_);
      if (byHdrLevel.length) {
        current = byHdrLevel;
      } else {
        log.warning('No exact match for the hdr level could be found.');
      }
    }

    if (this.channelCount_) {
      const byChannel = PreferenceBasedCriteria.filterVariantsByAudioChannelCount_(current, this.channelCount_);
      if (byChannel.length) {
        current = byChannel;
      } else {
        log.warning('No exact match for the channel count could be found.');
      }
    }

    if (this.audioLabel_) {
      const byLabel = PreferenceBasedCriteria.filterVariantsByAudioLabel_(current, this.audioLabel_);
      if (byLabel.length) {
        current = byLabel;
      } else {
        log.warning('No exact match for audio label could be found.');
      }
    }

    if (this.videoLabel_) {
      const byLabel = PreferenceBasedCriteria.filterVariantsByVideoLabel_(current, this.videoLabel_);
      if (byLabel.length) {
        current = byLabel;
      } else {
        log.warning('No exact match for video label could be found.');
      }
    }

    const bySpatialAudio = PreferenceBasedCriteria.filterVariantsBySpatialAudio_(current, this.spatialAudio_);
    if (bySpatialAudio.length) {
      current = bySpatialAudio;
    } else {
      log.warning('No exact match for spatial audio could be found.');
    }

    const supportsSmoothCodecTransitions =
      this.codecSwitchingStrategy_ == CodecSwitchingStrategy.SMOOTH && Capabilities.isChangeTypeSupported();

    return new AdaptationSet(current[0], current, !supportsSmoothCodecTransitions, this.enableAudioGroups_);
  }

  private static filterVariantsByRole_(variants: Variant[], preferredRole: string) {
    return variants.filter((variant) => {
      if (!variant.audio) {
        return false;
      }

      if (preferredRole) {
        return variant.audio.roles.includes(preferredRole);
      } else {
        return variant.audio.roles.length == 0;
      }
    });
  }

  private static filterByLanguage_(variants: Variant[], preferredLanguage: string): Variant[] {
    const perferedLocale = LanguageUtils.normalize(preferredLanguage);
    const closestLocale = LanguageUtils.findClosestLocale(
      perferedLocale,
      variants.map((variant) => LanguageUtils.getLocaleForVariant(variant))
    );

    // There were no locales close to what we preferred.
    if (!closestLocale) {
      return [];
    }

    // Find the variants that use the closest variant.
    return variants.filter((variant) => {
      return closestLocale == LanguageUtils.getLocaleForVariant(variant);
    });
  }

  /**
   * Filter Variants by audio label.
   *
   * @param  variants
   * @param
   * @return
   * @private
   */
  private static filterVariantsByAudioLabel_(variants: Variant[], preferredLabel: string) {
    return variants.filter((variant) => {
      if (!variant.audio || !variant.audio.label) {
        return false;
      }

      const label1 = variant.audio.label.toLowerCase();
      const label2 = preferredLabel.toLowerCase();
      return label1 == label2;
    });
  }

  private static filterVariantsByVideoLabel_(variants: Variant[], preferredLabel: string) {
    return variants.filter((variant) => {
      if (!variant.video || !variant.video.label) {
        return false;
      }

      const label1 = variant.video.label.toLowerCase();
      const label2 = preferredLabel.toLowerCase();
      return label1 == label2;
    });
  }

  private static filterVariantsByAudioChannelCount_(variants: Variant[], channelCount: number) {
    return variants.filter((variant) => {
      if (variant.audio && variant.audio.channelsCount && variant.audio.channelsCount != channelCount) {
        return false;
      }
      return true;
    });
  }

  private static filterVariantsByHDRLevel_(variants: Variant[], hdrLevel: string) {
    if (hdrLevel == 'AUTO') {
      // Auto detect the ideal HDR level.
      if (window.matchMedia('(color-gamut: p3)').matches) {
        hdrLevel = 'PQ';
      } else {
        hdrLevel = 'SDR';
      }
    }
    return variants.filter((variant) => {
      if (variant.video && variant.video.hdr && variant.video.hdr != hdrLevel) {
        return false;
      }
      return true;
    });
  }

  private static filterVariantsByVideoLayout_(variants: Variant[], videoLayout: string) {
    return variants.filter((variant) => {
      if (variant.video && variant.video.videoLayout && variant.video.videoLayout != videoLayout) {
        return false;
      }
      return true;
    });
  }

  private static filterVariantsBySpatialAudio_(variants: Variant[], spatialAudio: boolean) {
    return variants.filter((variant) => {
      if (variant.audio && variant.audio.spatialAudio != spatialAudio) {
        return false;
      }
      return true;
    });
  }
}

export class ExampleBasedCriteria implements AdaptationSetCriteria {
  private example_: Variant;
  private codecSwitchingStrategy_: CodecSwitchingStrategy;
  private enableAudioGroups_: boolean;
  private fallback_: PreferenceBasedCriteria;
  constructor(example: Variant, codecSwitchingStrategy = CodecSwitchingStrategy.RELOAD, enableAudioGroups = false) {
    this.example_ = example;
    this.codecSwitchingStrategy_ = codecSwitchingStrategy;
    this.enableAudioGroups_ = enableAudioGroups;

    // We can't know if role and label are really important, so we don't use
    // role and label for this.
    const role = '';
    const audioLabel = '';
    const videoLabel = '';
    const hdrLevel = '';
    const spatialAudio = false;
    const videoLayout = '';
    const channelCount = example.audio && example.audio.channelsCount ? example.audio.channelsCount : 0;

    this.fallback_ = new PreferenceBasedCriteria(
      example.language,
      role,
      channelCount,
      hdrLevel,
      spatialAudio,
      videoLayout,
      audioLabel,
      videoLabel,
      codecSwitchingStrategy,
      enableAudioGroups
    );
  }

  create(variants: Variant[]): AdaptationSet {
    const supportsSmoothCodecTransitions =
      this.codecSwitchingStrategy_ == CodecSwitchingStrategy.SMOOTH && Capabilities.isChangeTypeSupported();
    // We can't assume that the example is in |variants| because it could
    // actually be from another period.
    const shortList = variants.filter((variant) => {
      return AdaptationSet.areAdaptable(
        this.example_,
        variant,
        !supportsSmoothCodecTransitions,
        this.enableAudioGroups_
      );
    });

    if (shortList.length) {
      // Use the first item in the short list as the root. It should not matter
      // which element we use as all items in the short list should already be
      // compatible.
      return new AdaptationSet(shortList[0], shortList, !supportsSmoothCodecTransitions, this.enableAudioGroups_);
    } else {
      return this.fallback_.create(variants);
    }
  }
}
