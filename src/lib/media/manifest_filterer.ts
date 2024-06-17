import { PlayerConfiguration, Resolution } from '../../externs/shaka';
import { RestrictionInfo } from '../../externs/shaka/error';
import { Manifest, Stream } from '../../externs/shaka/manifest';
import { ShakaError } from '../util/error';

import { StreamUtils } from '../util/stream_utils';
import { DrmEngine } from './drm_engtine';

/**
 * A class that handles the filtering of manifests.
 * Allows for manifest filtering to be done both by the player and by a
 * preload manager.
 */
export class ManifestFilterer {
  private config_: PlayerConfiguration;
  private maxHwRes_: Resolution;
  private drmEngine_: DrmEngine | null;
  constructor(config: PlayerConfiguration, maxHwRes: Resolution, drmEngine: DrmEngine | null) {
    this.config_ = config;
    this.maxHwRes_ = maxHwRes;
    this.drmEngine_ = drmEngine;
  }

  setDrmEngine(drmEngine: DrmEngine) {
    this.drmEngine_ = drmEngine;
  }

  /**
   * Filters a manifest, removing unplayable streams/variants and  choosing
   * the codecs.
   * @param manifest
   * @returns tracksChanged
   */
  async filterManifest(manifest: Manifest): Promise<boolean> {
    await StreamUtils.filterManifest(this.drmEngine_, manifest, this.config_.drm!.preferredKeySystems);
    if (!this.config_.streaming.dontChooseCodecs) {
      StreamUtils.chooseCodecsAndFilterManifest(
        manifest,
        this.config_.preferredVideoCodecs,
        this.config_.preferredAudioCodecs,
        this.config_.preferredDecodingAttributes
      );
    }
    this.checkPlayableVariants_(manifest);
    return this.filterManifestWithRestrictions(manifest);
  }

  /**
   * @param  manifest
   * @return {boolean} tracksChanged
   */
  applyRestrictions(manifest: Manifest) {
    return StreamUtils.applyRestrictions(manifest.variants, this.config_.restrictions, this.maxHwRes_);
  }
  /**
   * Apply the restrictions configuration to the manifest, and check if there's
   * a variant that meets the restrictions.
   * @param manifest
   */
  filterManifestWithRestrictions(manifest: Manifest) {
    const tracksChanged = this.applyRestrictions(manifest);
    if (manifest) {
      // TODO(sanfeng): DRMEngine

      this.checkRestrictedVariants(manifest);
    }
    return tracksChanged;
  }

  checkPlayableVariants_(manifest: Manifest) {
    const valid = manifest.variants.some(StreamUtils.isPlayable);

    // If none of the variants are playable, throw
    // CONTENT_UNSUPPORTED_BY_BROWSER.
    if (!valid) {
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.MANIFEST,
        ShakaError.Code.CONTENT_UNSUPPORTED_BY_BROWSER
      );
    }
  }

  /**
   * Checks if the variants are all restricted, and throw an appropriate
   * exception if so.
   * @param manifest
   */
  checkRestrictedVariants(manifest: Manifest) {
    const restrictedStatuses = ManifestFilterer.restrictedStatuses;
    // TODO(sanfeng) DRMEngine
    const keyStatusMap: Record<string, any> = /* this.drmEngine_ ? this.drmEngine_.getKeyStatuses()  : */ {};
    const keyIds = Object.keys(keyStatusMap);
    const isGlobalStatus = keyIds.length && keyIds[0] == '00';
    let hasPlayable = false;
    let hasAppRestrictions = false;
    const missingKeys = new Set<string>();

    const badKeyStatuses = new Set<string>();
    for (const variant of manifest.variants) {
      // TODO: Combine with onKeyStatus_.
      const streams: Stream[] = [];
      if (variant.audio) {
        streams.push(variant.audio);
      }
      if (variant.video) {
        streams.push(variant.video);
      }

      for (const stream of streams) {
        if (stream.keyIds.size) {
          for (const keyId of stream.keyIds) {
            const keyStatus = keyStatusMap[isGlobalStatus ? '00' : keyId];
            if (!keyStatus) {
              missingKeys.add(keyId);
            } else if (restrictedStatuses.includes(keyStatus)) {
              badKeyStatuses.add(keyStatus);
            }
          }
        } // if (stream.keyIds.size)
      }
      if (!variant.allowedByApplication) {
        hasAppRestrictions = true;
      } else if (variant.allowedByKeySystem) {
        hasPlayable = true;
      }
    }
    if (!hasPlayable) {
      const data: RestrictionInfo = {
        hasAppRestrictions,
        missingKeys: Array.from(missingKeys),
        restrictedKeyStatuses: Array.from(badKeyStatuses),
      };
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.MANIFEST,
        ShakaError.Code.RESTRICTIONS_CANNOT_BE_MET,
        data
      );
    }
  }

  static restrictedStatuses = ['output-restricted', 'internal-error'];
}
