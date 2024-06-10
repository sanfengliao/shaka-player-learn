import { ManifestParserPlayerInterface } from '../../externs/shaka/manifest_parser';
import { NetworkingEngine } from '../net/network_engine';
import { FakeEventTarget } from '../util/fake_event_target';
import { IDestroyable } from '../util/i_destroyable';
import { PlayerConfiguration } from '../util/player_configuration';
import { AdaptationSetCriteria } from './adaptation_set_criteria';
import { DrmEngine } from './drm_engtine';
import { ManifestFilterer } from './manifest_filterer';
import { RegionTimeline } from './region_timeline';

export class PreloadManager extends FakeEventTarget implements IDestroyable {
  private assetUri_: string;
  private mimeType_: string;
  private startTime_: number;
  private startTimeOfLoad_: number;

  private networkingEngine_: NetworkingEngine;

  private currentAdaptationSetCriteria_: AdaptationSetCriteria | null = null;

  constructor(
    assetUri: string,
    mimeType: string,
    startTimeOfLoad: number,
    startTime: number,
    playerInterface: PreloadManagerPlayerInterface
  ) {
    super();
    this.assetUri_ = assetUri;
    this.startTime_ = startTime;
    this.startTimeOfLoad_ = startTimeOfLoad;
    this.mimeType_ = mimeType;
    this.networkingEngine_ = playerInterface.networkingEngine;
  }
  /**
   * TODO(sanfeng) implement destroy
   */
  async destroy(): Promise<void> {
    throw new Error('Method not implemented.');
  }

  getAssetUri() {
    return this.assetUri_;
  }

  getStartTime() {
    return this.startTime_;
  }

  getMimeType() {
    return this.mimeType_;
  }
}
export interface PreloadManagerPlayerInterface {
  config: PlayerConfiguration;
  manifestPlayerInterface: ManifestParserPlayerInterface;
  regionTimeline: RegionTimeline;
  createDrmEngine: () => DrmEngine;
  networkingEngine: NetworkingEngine;
  manifestFilterer: ManifestFilterer;
  allowPrefetch: boolean;
  allowMakeAbrManager: boolean;
}
