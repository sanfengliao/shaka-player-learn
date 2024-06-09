import { ManifestConfiguration } from '../../externs/shaka';
import { ManifestParserPlayerInterface } from '../../externs/shaka/manifest_parser';
import { Uri } from '../../third_party/closure-uri/uri';
import { ManifestParser } from '../media/manifest_parser';
import { NetworkingEngineRequestType, NetworkingEngine } from '../net/network_engine';
import { ShakaError } from './error';
import { IDestroyable } from './i_destroyable';
import { ManifestParserUtils } from './manifest_parser_utils';
import { OperationManager } from './operation_manager';
import { StringUtils } from './string_utils';
import { Timer } from './timer';

export class ContentSteeringManager implements IDestroyable {
  private config_: ManifestConfiguration | null = null;
  private playerInterface_: ManifestParserPlayerInterface;
  private baseUris_: string[] = [];
  private defaultPathwayId_: string | null = null;
  private pathwayPriority_: string[] = [];
  private lastPathwayUsed_: string | null = null;
  private pathwayClones_: ContentSteeringManagerPathawayClone[] = [];
  /**
   * Default to 5 minutes. Value in seconds.
   */
  private lastTTL_ = 300;

  private locations_ = new Map<string | number, Map<string, string>>();

  private bannedLocations_ = new Map<string, number>();

  private updateTimer_: Timer | null = null;

  private manifestType_ = ManifestParser.UNKNOWN;

  private operationManager_ = new OperationManager();

  constructor(playerInterface: ManifestParserPlayerInterface) {
    this.playerInterface_ = playerInterface;
  }

  configure(config: ManifestConfiguration) {
    this.config_ = config;
  }

  destroy() {
    this.config_ = null;
    this.playerInterface_ = null as any;
    this.baseUris_ = [];
    this.defaultPathwayId_ = null;
    this.pathwayPriority_ = [];
    this.pathwayClones_ = [];
    this.locations_.clear();

    if (this.updateTimer_ != null) {
      this.updateTimer_.stop();
      this.updateTimer_ = null;
    }

    return this.operationManager_.destroy();
  }

  setManifestType(manifestType: string) {
    this.manifestType_ = manifestType;
  }

  setBaseUris(baseUris: string[]) {
    this.baseUris_ = baseUris;
  }

  setDefaultPathwayId(defaultPathwayId: string | null) {
    this.defaultPathwayId_ = defaultPathwayId;
  }

  /**
   * Request the Content Steering info.
   *
   * @param uri
   * @return
   */
  async requestInfo(uri: string) {
    const uris = ManifestParserUtils.resolveUris(this.baseUris_, [this.addQueryParams_(uri)]);

    const type = NetworkingEngineRequestType.CONTENT_STEERING;
    const request = NetworkingEngine.makeRequest(uris, this.config_!.retryParameters);
    const op = this.playerInterface_.networkingEngine.request(type, request);
    this.operationManager_.manage(op);

    try {
      const response = await op.promise;
      const str = StringUtils.fromUTF8(response.data);
      const steeringManifest: SteeringManifest = JSON.parse(str);
      if (steeringManifest.VERSION == 1) {
        this.processManifest_(steeringManifest, response.uri);
      }
    } catch (e: any) {
      if (e && e.code === ShakaError.Code.OPERATION_ABORTED) {
        return;
      }
      if (this.updateTimer_ != null) {
        this.updateTimer_.stop();
        this.updateTimer_ = null;
      }
      this.updateTimer_ = new Timer(() => {
        this.requestInfo(uri);
      });
      this.updateTimer_.tickAfter(this.lastTTL_);
    }
  }

  private addQueryParams_(uri: string): string {
    if (!this.pathwayPriority_.length) {
      return uri;
    }

    const finalUri = new Uri(uri);
    const currentPathwayID = this.lastPathwayUsed_ || this.pathwayPriority_[0];
    const currentBandwidth = this.playerInterface_.getBandwidthEstimate();
    const queryData = finalUri.getQueryData();

    if (this.manifestType_ == ManifestParser.DASH) {
      queryData.add('_DASH_pathway', currentPathwayID);
      queryData.add('_DASH_throughput', String(currentBandwidth));
    } else if (this.manifestType_ == ManifestParser.HLS) {
      queryData.add('_HLS_pathway', currentPathwayID);
      queryData.add('_HLS_throughput', String(currentBandwidth));
    }
    if (queryData.getCount()) {
      finalUri.setQueryData(queryData);
    }
    return finalUri.toString();
  }

  private processManifest_(manifest: SteeringManifest, finalManifestUri: string) {
    if (this.updateTimer_ != null) {
      this.updateTimer_.stop();
      this.updateTimer_ = null;
    }
    const uri = manifest['RELOAD-URI'] || finalManifestUri;
    this.updateTimer_ = new Timer(() => {
      this.requestInfo(uri);
    });
    const newTTL = manifest['TTL'];
    if (newTTL) {
      this.lastTTL_ = newTTL;
    }
    this.updateTimer_.tickAfter(this.lastTTL_);
    this.pathwayPriority_ = manifest['PATHWAY-PRIORITY'] || [];
    this.pathwayClones_ = manifest['PATHWAY-CLONES'] || [];
  }

  /**
   * Clear the previous locations added.
   */
  clearPreviousLocations() {
    this.locations_.clear();
  }

  addLocation(streamId: string | number, pathwayId: string, uri: string) {
    let streamLocations = this.locations_.get(streamId);
    if (!streamLocations) {
      streamLocations = new Map();
    }
    streamLocations.set(pathwayId, uri);
    this.locations_.set(streamId, streamLocations);
  }

  /**
   * @param uri
   */
  banLocation(uri: string) {
    const bannedUntil = Date.now() + 60000;
    this.bannedLocations_.set(uri, bannedUntil);
  }

  /**
   * Get the base locations ordered according the priority.
   * @param streamId
   * @param ignoreBaseUrls
   */
  getLocations(streamId: string | number, ignoreBaseUrls = false): string[] {
    const streamLocations = this.locations_.get(streamId) || new Map();
    let locationsPathwayIdMap: {
      pathwayId: string;
      location: string;
    }[] = [];
    for (const pathwayId of this.pathwayPriority_) {
      const location = streamLocations.get(pathwayId);
      if (location) {
        locationsPathwayIdMap.push({ pathwayId, location });
      } else {
        const clone = this.pathwayClones_.find((c) => c.ID == pathwayId);
        if (clone) {
          const cloneLocation = streamLocations.get(clone['BASE-ID']);
          if (cloneLocation) {
            if (clone['URI-REPLACEMENT'].HOST) {
              const uri = new Uri(cloneLocation);
              uri.setDomain(clone['URI-REPLACEMENT'].HOST);
              locationsPathwayIdMap.push({
                pathwayId: pathwayId,
                location: uri.toString(),
              });
            } else {
              locationsPathwayIdMap.push({
                pathwayId: pathwayId,
                location: cloneLocation,
              });
            }
          }
        }
      }
    }

    const now = Date.now();
    for (const uri of this.bannedLocations_.keys()) {
      const bannedUntil = this.bannedLocations_.get(uri)!;
      if (now > bannedUntil) {
        this.bannedLocations_.delete(uri);
      }
    }

    locationsPathwayIdMap = locationsPathwayIdMap.filter((l) => {
      for (const uri of this.bannedLocations_.keys()) {
        if (uri.includes(new Uri(l.location).getDomain())) {
          return false;
        }
      }
      return true;
    });

    if (locationsPathwayIdMap.length) {
      this.lastPathwayUsed_ = locationsPathwayIdMap[0].pathwayId;
    }

    const locations = locationsPathwayIdMap.map((l) => l.location);

    if (!locations.length && this.defaultPathwayId_) {
      for (const pathwayId of this.defaultPathwayId_.split(',')) {
        const location = streamLocations.get(pathwayId);
        if (location) {
          this.lastPathwayUsed_ = this.defaultPathwayId_;
          locations.push(location);
        }
      }
    }

    if (!locations.length) {
      for (const location of streamLocations.values()) {
        locations.push(location);
      }
    }
    if (ignoreBaseUrls) {
      return locations;
    }
    return ManifestParserUtils.resolveUris(this.baseUris_, locations);
  }
}

export interface ContentSteeringManagerPathawayClone {
  'BASE-ID': string;
  ID: string;
  'URI-REPLACEMENT': ContentSteeringManagerUriReplacement;
}
export interface ContentSteeringManagerUriReplacement {
  HOST: string;
}

export interface SteeringManifest {
  VERSION: number;
  TTL: number;
  'RELOAD-URI': string;
  'PATHWAY-PRIORITY': string[];
  'PATHWAY-CLONES': ContentSteeringManagerPathawayClone[];
}
