import { ManifestConfiguration, TimelineRegionInfo, XmlNode } from '../../externs/shaka';
import { AesKey, DrmInfo, Manifest, Period, ServiceDescription, Stream, Variant } from '../../externs/shaka/manifest';
import { IManifestParser, ManifestParserPlayerInterface } from '../../externs/shaka/manifest_parser';
import { Request, RequestContext } from '../../externs/shaka/net';
import { Ewma } from '../abr/ewma';
import { asserts } from '../debug/asserts';
import { log } from '../debug/log';
import { Deprecate } from '../deprecate/deprecate';
import { AccessibilityPurpose, ManifestParser } from '../media/manifest_parser';
import { Capabilities } from '../media/media_source_capabilities';
import { PresentationTimeline } from '../media/presentation_timeline';
import { SegmentIndex } from '../media/segment_index';
import { SegmentUtils } from '../media/segment_utils';
import {
  NetworkingEngineRequestType,
  NetworkingEngineAdvancedRequestType,
  NetworkingEngine,
} from '../net/network_engine';
import { TextEngine } from '../text/text_engine';
import { ContentSteeringManager } from '../util/content_steering_manager';
import { ShakaError } from '../util/error';
import { Functional } from '../util/functional';
import { LanguageUtils } from '../util/language_utils';
import { ManifestParserUtils } from '../util/manifest_parser_utils';
import { MimeUtils } from '../util/mime_utils';
import { Networking } from '../util/networking';
import { OperationManager } from '../util/operation_manager';
import { PeriodCombiner } from '../util/period';
import { PlayerConfiguration } from '../util/player_configuration';
import { StringUtils } from '../util/string_utils';
import { TXml, TXmlPathNode } from '../util/tXml';
import { Timer } from '../util/timer';
import { XmlUtils } from '../util/xml_utils';
import { ContentProtection, ContentProtectionContext } from './content_protection';
import { MpdUtils } from './mpd_utils';
import { SegmentBase } from './segment_base';
import { SegmentList } from './segment_list';
import { SegmentTemplate } from './segment_template';

export class DashParser implements IManifestParser {
  private static SCTE214_ = 'urn:scte:dash:scte214-extensions';
  private config_!: ManifestConfiguration;
  private playerInterface_!: ManifestParserPlayerInterface;
  private manifestUris_: string[] = [];
  private manifest_!: Manifest;
  private globalId_ = 1;
  private patchLocationNodes_: XmlNode[] = [];
  /**
   * A context of the living manifest used for processing
   * Patch MPD's
   */
  private manifestPatchContext_: DashParserPatchContext = {
    mpdId: '',
    type: '',
    profiles: [],
    mediaPresentationDuration: null,
    availabilityTimeOffset: 0,
    getBaseUris: null,
    publishTime: 0,
  };

  /**
   * This is a cache is used the store a snapshot of the context
   * object which is built up throughout node traversal to maintain
   * a current state. This data needs to be preserved for parsing
   * patches.
   * The key is a combination period and representation id's.
   *
   */
  private contextCache_: Map<string, DashParserContext> = new Map();
  /**
   * A map of IDs to Stream objects.
   * ID: Period@id,AdaptationSet@id,@Representation@id
   * e.g.: '1,5,23'
   *
   */
  private streamMap_: Record<string, Stream> = {};

  /**
   * A map of period ids to their durations
   */
  private periodDurations_: Record<string, number> = {};
  private periodCombiner_ = new PeriodCombiner();

  /**
   * the update period in seconds, or 0 for no updates.
   */
  private updatePeriod_ = 0;

  private averageUpdateDuration_ = new Ewma(5);

  private updateTimer_ = new Timer(() => {
    this.onUpdate_();
  });

  private operationManager_ = new OperationManager();
  /**
   *  Largest period start time seen.
   */
  private largestPeriodStartTime_: number | null = null;

  /**
   * Period IDs seen in previous manifest.
   */
  private lastManifestUpdatePeriodIds_: string[] = [];

  /**
   * The minimum of the availabilityTimeOffset values among the adaptation
   * sets.
   */
  private minTotalAvailabilityTimeOffset_ = Infinity;

  private lowLatencyMode_ = false;
  private contentSteeringManager_: ContentSteeringManager | null = null;

  configure(config: ManifestConfiguration) {
    asserts.assert(config.dash != null, 'DashManifestConfiguration should not be null!');
    const needFireUpdate =
      this.playerInterface_ &&
      config.dash.updatePeriod != this.config_?.dash.updatePeriod &&
      config.dash.updatePeriod >= 0;
    this.config_ = config;
    if (needFireUpdate && this.manifest_ && this.manifest_.presentationTimeline.isLive()) {
      this.updateNow_();
    }

    if (this.contentSteeringManager_) {
      this.contentSteeringManager_.configure(this.config_);
    }
    if (this.periodCombiner_) {
      this.periodCombiner_.setAllowMultiTypeVariants(
        this.config_.dash.multiTypeVariantsAllowed && Capabilities.isChangeTypeSupported()
      );
      this.periodCombiner_.setUseStreamOnce(this.config_.dash.useStreamOnceInPeriodFlattening);
    }
  }

  async start(uri: string, playerInterface: ManifestParserPlayerInterface): Promise<Manifest> {
    asserts.assert(this.config_, 'Must call configure() before start()!');
    this.lowLatencyMode_ = playerInterface.isLowLatencyMode();
    this.manifestUris_ = [uri];
    this.playerInterface_ = playerInterface;

    const updateDelay = await this.requestManifest_();

    if (this.playerInterface_) {
      this.setUpdateTimer_(updateDelay);
    }

    // Make sure that the parser has not been destroyed.
    if (!this.playerInterface_) {
      throw new ShakaError(ShakaError.Severity.CRITICAL, ShakaError.Category.PLAYER, ShakaError.Code.OPERATION_ABORTED);
    }

    asserts.assert(this.manifest_, 'Manifest should be non-null!');
    return this.manifest_;
  }

  stop(): Promise<void> {
    // When the parser stops, release all segment indexes, which stops their
    // timers, as well.
    for (const stream of Object.values(this.streamMap_)) {
      if (stream.segmentIndex) {
        stream.segmentIndex.release();
      }
    }

    if (this.periodCombiner_) {
      this.periodCombiner_.release();
    }

    this.playerInterface_ = null as any;
    this.config_ = null as any;
    this.manifestUris_ = [];
    this.manifest_ = null as any;
    this.streamMap_ = {};
    this.contextCache_.clear();
    this.manifestPatchContext_ = {
      mpdId: '',
      type: '',
      profiles: [],
      mediaPresentationDuration: null,
      availabilityTimeOffset: 0,
      getBaseUris: null,
      publishTime: 0,
    };
    this.periodCombiner_ = null as any;

    if (this.updateTimer_ != null) {
      this.updateTimer_.stop();
      this.updateTimer_ = null as any;
    }

    if (this.contentSteeringManager_) {
      this.contentSteeringManager_.destroy();
    }

    return this.operationManager_.destroy();
  }

  async update() {
    try {
      await this.requestManifest_();
    } catch (error) {
      if (!this.playerInterface_ || !error) {
        return;
      }
      asserts.assert(error instanceof ShakaError, 'Bad error type');
      this.playerInterface_.onError(error as ShakaError);
    }
  }

  onExpirationUpdated(sessionId: string, expiration: number): void {}

  onInitialVariantChosen(variant: Variant): void {
    if (this.manifest_ && this.manifest_.presentationTimeline.isLive()) {
      const stream = variant.video || variant.audio;
      if (stream && stream.segmentIndex) {
        const availabilityEnd = this.manifest_.presentationTimeline.getSegmentAvailabilityEnd();
        const position = stream.segmentIndex.find(availabilityEnd);
        if (position == null) {
          return;
        }
        const reference = stream.segmentIndex.get(position);
        if (!reference) {
          return;
        }
        this.updatePeriod_ = reference.endTime - availabilityEnd;
        this.setUpdateTimer_(/* offset= */ 0);
      }
    }
  }

  banLocation(uri: string): void {
    if (this.contentSteeringManager_) {
      this.contentSteeringManager_.banLocation(uri);
    }
  }

  /**
   * Makes a network request for the manifest and parses the resulting data.
   *
   * @return {!Promise.<number>} Resolves with the time it took, in seconds, to
   *   fulfill the request and parse the data.
   * @private
   */
  private async requestManifest_(): Promise<number> {
    const requestType = NetworkingEngineRequestType.MANIFEST;
    const type = NetworkingEngineAdvancedRequestType.MPD;
    let rootElement = 'MPD';
    const patchLocationUris = this.getPatchLocationUris_();
    let manifestUris = this.manifestUris_;
    if (patchLocationUris.length) {
      manifestUris = patchLocationUris;
      rootElement = 'Patch';
    } else if (this.manifestUris_.length > 1 && this.contentSteeringManager_) {
      const locations = this.contentSteeringManager_.getLocations('Location', /* ignoreBaseUrls= */ true);
      if (locations.length) {
        manifestUris = locations;
      }
    }
    const request = NetworkingEngine.makeRequest(manifestUris, this.config_!.retryParameters);
    const startTime = Date.now();

    const response = await this.makeNetworkRequest_(request, requestType, { type });

    // Detect calls to stop().
    if (!this.playerInterface_) {
      return 0;
    }
    if (response.uri && response.uri != response.originalUri && !this.manifestUris_.includes(response.uri)) {
      this.manifestUris_.unshift(response.uri);
    }

    // This may throw, but it will result in a failed promise.
    await this.parseManifest_(response.data, response.uri, rootElement);
    // Keep track of how long the longest manifest update took.
    const endTime = Date.now();
    const updateDuration = (endTime - startTime) / 1000.0;
    this.averageUpdateDuration_.sample(1, updateDuration);

    // Let the caller know how long this update took.
    return updateDuration;
  }

  /**
   * Parses the manifest XML.  This also handles updates and will update the
   * stored manifest.
   * @param data
   * @param finalManifestUri The final manifest URI, which may
   *   differ from this.manifestUri_ if there has been a redirect.
   * @param rootElement MPD or Patch, depending on context
   */
  private async parseManifest_(data: BufferSource, finalManifestUri: string, rootElement: string) {
    let manifestData = data;
    const manifestPreprocessor = this.config_!.dash.manifestPreprocessor;
    const defaultManifestPreprocessor = PlayerConfiguration.defaultManifestPreprocessor;

    if (manifestPreprocessor !== defaultManifestPreprocessor) {
      Deprecate.deprecateFeature(
        5,
        'manifest.dash.manifestPreprocessor configuration',
        'Please Use manifest.dash.manifestPreprocessorTXml instead.'
      );
      const mpdElement = XmlUtils.parseXml(manifestData, rootElement);
      if (!mpdElement) {
        throw new ShakaError(
          ShakaError.Severity.CRITICAL,
          ShakaError.Category.MANIFEST,
          ShakaError.Code.DASH_INVALID_XML,
          finalManifestUri
        );
      }
      manifestPreprocessor(mpdElement);
      manifestData = XmlUtils.toArrayBuffer(mpdElement);
    }

    const mpd = TXml.parseXml(manifestData, rootElement);

    if (!mpd) {
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.MANIFEST,
        ShakaError.Code.DASH_INVALID_XML,
        finalManifestUri
      );
    }
    const manifestPreprocessorTXml = this.config_!.dash.manifestPreprocessorTXml;
    const defaultManifestPreprocessorTXml = PlayerConfiguration.defaultManifestPreprocessorTXml;
    if (manifestPreprocessorTXml != defaultManifestPreprocessorTXml) {
      manifestPreprocessorTXml(mpd);
    }

    // TODO(sanfeng): 搞定patch
    if (rootElement === 'Patch') {
      return this.processPatchManifest_(mpd);
    }

    const disableXlinkProcessing = this.config_!.dash.disableXlinkProcessing;
    if (disableXlinkProcessing) {
      return this.processManifest_(mpd, finalManifestUri);
    }

    // Process the mpd to account for xlink connections.
    const failGracefully = this.config_!.dash.xlinkFailGracefully;
    const xlinkOperation = MpdUtils.processXlinks(
      mpd,
      this.config_!.retryParameters,
      failGracefully,
      finalManifestUri,
      this.playerInterface_.networkingEngine
    );
    this.operationManager_.manage(xlinkOperation);
    const finalMpd = await xlinkOperation.promise;
    return this.processManifest_(finalMpd, finalManifestUri);
  }

  /**
   * Takes a formatted MPD and converts it into a manifest.
   * @param mpd
   * @param finalManifestUri The final manifest URI, which may
   *   differ from this.manifestUri_ if there has been a redirect.
   */
  private async processManifest_(mpd: XmlNode, finalManifestUri: string) {
    asserts.assert(this.config_, 'Must call configure() before processManifest_()!');

    if (this.contentSteeringManager_) {
      this.contentSteeringManager_.clearPreviousLocations();
    }

    // Get any Location elements.  This will update the manifest location and
    // the base URI.
    let manifestBaseUris = [finalManifestUri];
    const locations: string[] = [];

    const locationsMapping = new Map();
    const locationsObjs = TXml.findChildren(mpd, 'Location');
    for (const locationsObj of locationsObjs) {
      const serviceLocation = locationsObj.attributes['serviceLocation'];
      const uri = TXml.getContents(locationsObj);
      if (!uri) {
        continue;
      }
      const finalUri = ManifestParserUtils.resolveUris(manifestBaseUris, [uri])[0];
      if (serviceLocation) {
        if (this.contentSteeringManager_) {
          this.contentSteeringManager_.addLocation('Location', serviceLocation, finalUri);
        } else {
          locationsMapping.set(serviceLocation, finalUri);
        }
      }
      locations.push(finalUri);
    }

    if (this.contentSteeringManager_) {
      const steeringlocations = this.contentSteeringManager_.getLocations('Location', /* ignoreBaseUrls= */ true);
      if (steeringlocations.length > 0) {
        this.manifestUris_ = steeringlocations;
        manifestBaseUris = steeringlocations;
      }
    } else if (locations.length) {
      this.manifestUris_ = locations;
      manifestBaseUris = locations;
    }

    this.manifestPatchContext_.mpdId = mpd.attributes['id'] || '';
    this.manifestPatchContext_.publishTime = TXml.parseAttr(mpd, 'publishTime', TXml.parseDate) || 0;
    this.patchLocationNodes_ = TXml.findChildren(mpd, 'PatchLocation');
    let contentSteeringPromise = Promise.resolve();

    const contentSteering = TXml.findChild(mpd, 'ContentSteering');
    if (contentSteering && this.playerInterface_) {
      const defaultPathwayId = contentSteering.attributes['defaultServiceLocation'];
      if (!this.contentSteeringManager_) {
        this.contentSteeringManager_ = new ContentSteeringManager(this.playerInterface_);
        this.contentSteeringManager_.configure(this.config_!);
        this.contentSteeringManager_.setManifestType(ManifestParser.DASH);
        this.contentSteeringManager_.setBaseUris(manifestBaseUris);
        this.contentSteeringManager_.setDefaultPathwayId(defaultPathwayId);
        const uri = TXml.getContents(contentSteering);
        if (uri) {
          const queryBeforeStart = TXml.parseAttr(
            contentSteering,
            'queryBeforeStart',
            TXml.parseBoolean,
            /* defaultValue= */ false
          );
          if (queryBeforeStart) {
            contentSteeringPromise = this.contentSteeringManager_.requestInfo(uri);
          } else {
            this.contentSteeringManager_.requestInfo(uri);
          }
        }
      } else {
        this.contentSteeringManager_.setBaseUris(manifestBaseUris);
        this.contentSteeringManager_.setDefaultPathwayId(defaultPathwayId);
      }

      for (const serviceLocation of locationsMapping.keys()) {
        const uri = locationsMapping.get(serviceLocation);
        this.contentSteeringManager_.addLocation('Location', serviceLocation, uri);
      }
    }

    const uriObjs = TXml.findChildren(mpd, 'BaseURL');
    let calculatedBaseUris: string[];
    let someLocationValid = false;
    if (this.contentSteeringManager_) {
      for (const uriObj of uriObjs) {
        const serviceLocation = uriObj.attributes['serviceLocation'];
        const uri = TXml.getContents(uriObj);
        if (serviceLocation && uri) {
          this.contentSteeringManager_.addLocation('BaseURL', serviceLocation, uri);
          someLocationValid = true;
        }
      }
    }

    if (!someLocationValid || !this.contentSteeringManager_) {
      const uris = uriObjs.map(TXml.getContents);
      calculatedBaseUris = ManifestParserUtils.resolveUris(manifestBaseUris, uris as string[]);
    }

    const getBaseUris = () => {
      if (this.contentSteeringManager_ && someLocationValid) {
        return this.contentSteeringManager_.getLocations('BaseURL');
      }
      if (calculatedBaseUris) {
        return calculatedBaseUris;
      }
      return [];
    };

    this.manifestPatchContext_.getBaseUris = getBaseUris;

    let availabilityTimeOffset = 0;
    if (uriObjs && uriObjs.length) {
      availabilityTimeOffset = TXml.parseAttr(uriObjs[0], 'availabilityTimeOffset', TXml.parseFloat) || 0;
    }

    this.manifestPatchContext_.availabilityTimeOffset = availabilityTimeOffset;

    const ignoreMinBufferTime = this.config_!.dash.ignoreMinBufferTime;

    let minBufferTime = 0;
    if (!ignoreMinBufferTime) {
      minBufferTime = TXml.parseAttr(mpd, 'minBufferTime', TXml.parseDuration) || 0;
    }

    this.updatePeriod_ = TXml.parseAttr(mpd, 'minimumUpdatePeriod', TXml.parseDuration, -1) as number;

    const presentationStartTime = TXml.parseAttr(mpd, 'availabilityStartTime', TXml.parseDate) as number;
    let segmentAvailabilityDuration = TXml.parseAttr(mpd, 'timeShiftBufferDepth', TXml.parseDuration) as number;

    const ignoreSuggestedPresentationDelay = this.config_!.dash.ignoreSuggestedPresentationDelay;
    let suggestedPresentationDelay: number | null = null;
    if (!ignoreSuggestedPresentationDelay) {
      suggestedPresentationDelay = TXml.parseAttr(mpd, 'suggestedPresentationDelay', TXml.parseDuration) as number;
    }

    const ignoreMaxSegmentDuration = this.config_!.dash.ignoreMaxSegmentDuration;
    let maxSegmentDuration: number | null = null;
    if (!ignoreMaxSegmentDuration) {
      maxSegmentDuration = TXml.parseAttr(mpd, 'maxSegmentDuration', TXml.parseDuration);
    }
    const mpdType = mpd.attributes['type'] || 'static';

    this.manifestPatchContext_.type = mpdType;

    let presentationTimeline: PresentationTimeline;
    if (this.manifest_) {
      presentationTimeline = this.manifest_.presentationTimeline;
      // Before processing an update, evict from all segment indexes.  Some of
      // them may not get updated otherwise if their corresponding Period
      // element has been dropped from the manifest since the last update.
      // Without this, playback will still work, but this is necessary to
      // maintain conditions that we assert on for multi-Period content.
      // This gives us confidence that our state is maintained correctly, and
      // that the complex logic of multi-Period eviction and period-flattening
      // is correct.  See also:
      // https://github.com/shaka-project/shaka-player/issues/3169#issuecomment-823580634
      for (const stream of Object.values(this.streamMap_)) {
        if (stream.segmentIndex) {
          stream.segmentIndex.evict(presentationTimeline.getSegmentAvailabilityStart());
        }
      }
    } else {
      // DASH IOP v3.0 suggests using a default delay between minBufferTime
      // and timeShiftBufferDepth.  This is literally the range of all
      // feasible choices for the value.  Nothing older than
      // timeShiftBufferDepth is still available, and anything less than
      // minBufferTime will cause buffering issues.
      //
      // We have decided that our default will be the configured value, or
      // 1.5 * minBufferTime if not configured. This is fairly conservative.
      // Content providers should provide a suggestedPresentationDelay whenever
      // possible to optimize the live streaming experience.
      const defaultPresentationDelay = this.config_!.defaultPresentationDelay || minBufferTime * 1.5;
      const presentationDelay =
        suggestedPresentationDelay != null ? suggestedPresentationDelay : defaultPresentationDelay;
      presentationTimeline = new PresentationTimeline(
        presentationStartTime,
        presentationDelay,
        this.config_!.dash.autoCorrectDrift
      );
    }

    presentationTimeline.setStatic(mpdType == 'static');

    const isLive = presentationTimeline.isLive();

    // If it's live, we check for an override.
    if (isLive && !isNaN(this.config_!.availabilityWindowOverride)) {
      segmentAvailabilityDuration = this.config_!.availabilityWindowOverride;
    }
    // If it's null, that means segments are always available.  This is always
    // the case for VOD, and sometimes the case for live.
    if (segmentAvailabilityDuration === null) {
      segmentAvailabilityDuration = Infinity;
    }

    presentationTimeline.setSegmentAvailabilityDuration(segmentAvailabilityDuration);

    const profiles = mpd.attributes['profiles'] || '';
    this.manifestPatchContext_.profiles = profiles.split(',');

    const context: DashParserContext = {
      // Don't base on updatePeriod_ since emsg boxes can cause manifest
      // updates.
      dynamic: mpdType != 'static',
      presentationTimeline: presentationTimeline,
      period: null,
      periodInfo: null,
      adaptationSet: null,
      representation: null,
      bandwidth: 0,
      indexRangeWarningGiven: false,
      availabilityTimeOffset: availabilityTimeOffset,
      mediaPresentationDuration: null,
      profiles: profiles.split(','),
    };

    const periodsAndDuration = this.parsePeriods_(context, getBaseUris, mpd);
    const duration = periodsAndDuration.duration;
    const periods = periodsAndDuration.periods;

    if (mpdType == 'static' || !periodsAndDuration.durationDerivedFromPeriods) {
      // Ignore duration calculated from Period lengths if this is dynamic.
      presentationTimeline.setDuration(duration || Infinity);
    }

    // The segments are available earlier than the availability start time.
    // If the stream is low latency and the user has not configured the
    // lowLatencyMode, but if it has been configured to activate the
    // lowLatencyMode if a stream of this type is detected, we automatically
    // activate the lowLatencyMode.
    if (this.minTotalAvailabilityTimeOffset_ && !this.lowLatencyMode_) {
      const autoLowLatencyMode = this.playerInterface_.isAutoLowLatencyMode();
      if (autoLowLatencyMode) {
        this.playerInterface_.enableLowLatencyMode();
        this.lowLatencyMode_ = this.playerInterface_.isLowLatencyMode();
      }
    }
    if (this.lowLatencyMode_) {
      presentationTimeline.setAvailabilityTimeOffset(this.minTotalAvailabilityTimeOffset_);
    } else if (this.minTotalAvailabilityTimeOffset_) {
      // If the playlist contains AvailabilityTimeOffset value, the
      // streaming.lowLatencyMode value should be set to true to stream with low
      // latency mode.
      log.alwaysWarn(
        'Low-latency DASH live stream detected, but ' +
          'low-latency streaming mode is not enabled in Shaka Player. ' +
          'Set streaming.lowLatencyMode configuration to true, and see ' +
          'https://bit.ly/3clctcj for details.'
      );
    }

    // Use @maxSegmentDuration to override smaller, derived values.
    presentationTimeline.notifyMaxSegmentDuration(maxSegmentDuration || 1);
    if (__DEV__) {
      presentationTimeline.assertIsValid();
    }

    await contentSteeringPromise;

    // Set minBufferTime to 0 for low-latency DASH live stream to achieve the
    // best latency
    if (this.lowLatencyMode_) {
      minBufferTime = 0;
      const presentationDelay =
        suggestedPresentationDelay != null ? suggestedPresentationDelay : this.config_!.defaultPresentationDelay;
      presentationTimeline.setDelay(presentationDelay);
    }

    // These steps are not done on manifest update.
    if (!this.manifest_) {
      await this.periodCombiner_.combinePeriods(periods, context.dynamic);
      this.manifest_ = {
        presentationTimeline: presentationTimeline,
        variants: this.periodCombiner_.getVariants(),
        textStreams: this.periodCombiner_.getTextStreams(),
        imageStreams: this.periodCombiner_.getImageStreams(),
        offlineSessionIds: [],
        minBufferTime: minBufferTime || 0,
        sequenceMode: this.config_!.dash.sequenceMode,
        ignoreManifestTimestampsInSegmentsMode: false,
        type: ManifestParser.DASH,
        serviceDescription: this.parseServiceDescription_(mpd),
        nextUrl: this.parseMpdChaining_(mpd),
        // periodCount: periods.length,
      };

      // We only need to do clock sync when we're using presentation start
      // time. This condition also excludes VOD streams.
      if (presentationTimeline.usingPresentationStartTime()) {
        const timingElements = TXml.findChildren(mpd, 'UTCTiming');
        const offset = await this.parseUtcTiming_(getBaseUris, timingElements);
        // Detect calls to stop().
        if (!this.playerInterface_) {
          return;
        }
        presentationTimeline.setClockOffset(offset);
      }

      // This is the first point where we have a meaningful presentation start
      // time, and we need to tell PresentationTimeline that so that it can
      // maintain consistency from here on.
      presentationTimeline.lockStartTime();
    } else {
      await this.postPeriodProcessing_(periodsAndDuration.periods, /* isPatchUpdate= */ false);
    }

    // Add text streams to correspond to closed captions.  This happens right
    // after period combining, while we still have a direct reference, so that
    // any new streams will appear in the period combiner.
    this.playerInterface_.makeTextStreamsForClosedCaptions(this.manifest_);
  }

  /**
   *  Handles common procedures after processing new periods.
   * @param periods periods to be appended
   * @param isPatchUpdate does call comes from mpd patch update
   */
  private async postPeriodProcessing_(periods: Period[], isPatchUpdate: boolean) {
    await this.periodCombiner_.combinePeriods(periods, true, isPatchUpdate);

    // Just update the variants and text streams, which may change as periods
    // are added or removed.
    this.manifest_!.variants = this.periodCombiner_.getVariants();
    const textStreams = this.periodCombiner_.getTextStreams();
    if (textStreams.length > 0) {
      this.manifest_!.textStreams = textStreams;
    }
    this.manifest_!.imageStreams = this.periodCombiner_.getImageStreams();

    // Re-filter the manifest.  This will check any configured restrictions on
    // new variants, and will pass any new init data to DrmEngine to ensure
    // that key rotation works correctly.
    this.playerInterface_.filter(this.manifest_);
  }

  /**
   * Takes a formatted Patch MPD and converts it into a manifest.
   * @param mpd
   */
  private async processPatchManifest_(mpd: XmlNode) {
    const mpdId = mpd.attributes['mpdId'];
    const originalPublishTime = TXml.parseAttr(mpd, 'originalPublishTime', TXml.parseDate);
    if (
      !mpdId ||
      mpdId !== this.manifestPatchContext_.mpdId ||
      originalPublishTime !== this.manifestPatchContext_.publishTime
    ) {
      // Clean patch location nodes, so it will force full MPD update.
      this.patchLocationNodes_ = [];
      throw new ShakaError(
        ShakaError.Severity.RECOVERABLE,
        ShakaError.Category.MANIFEST,
        ShakaError.Code.DASH_INVALID_PATCH
      );
    }

    const newPeriods: Period[] = [];

    const periodAdditions: XmlNode[] = [];

    const modifiedTimelines = new Set<string>();
    for (const patchNode of TXml.getChildNodes(mpd)) {
      let handled = true;
      const paths = TXml.parseXpath(patchNode.attributes['sel'] || '');
      const node = paths[paths.length - 1];
      const content = TXml.getContents(patchNode) || '';

      if (node.name === 'MPD') {
        if (node.attribute === 'mediaPresentationDuration') {
          const content = TXml.getContents(patchNode) || '';
          this.parsePatchMediaPresentationDurationChange_(content);
        } else if (node.attribute === 'type') {
          this.parsePatchMpdTypeChange_(content);
        } else if (node.attribute === 'publishTime') {
          this.manifestPatchContext_.publishTime = TXml.parseDate(content) || 0;
        } else if (node.attribute === null && patchNode.tagName === 'add') {
          periodAdditions.push(patchNode);
        } else {
          handled = false;
        }
      } else if (node.name === 'PatchLocation') {
        this.updatePatchLocationNodes_(patchNode);
      } else if (node.name === 'Period') {
        if (patchNode.tagName === 'add') {
          periodAdditions.push(patchNode);
        } else if (patchNode.tagName === 'remove' && node.id) {
          this.removePatchPeriod_(node.id);
        }
      } else if (node.name === 'SegmentTemplate') {
        const timelines = this.modifySegmentTemplate_(patchNode);
        for (const timeline of timelines) {
          modifiedTimelines.add(timeline);
        }
      } else if (node.name === 'SegmentTimeline' || node.name === 'S') {
        const timelines = this.modifyTimepoints_(patchNode);
        for (const timeline of timelines) {
          modifiedTimelines.add(timeline);
        }
      } else {
        handled = false;
      }

      if (!handled) {
        log.warning('Unhandled ' + patchNode.tagName + ' operation', patchNode.attributes['sel']);
      }
    }

    for (const timeline of modifiedTimelines) {
      this.parsePatchSegment_(timeline);
    }

    // Add new periods after extending timelines, as new periods
    // remove context cache of previous periods.
    for (const periodAddition of periodAdditions) {
      newPeriods.push(...this.parsePatchPeriod_(periodAddition));
    }

    if (newPeriods.length) {
      await this.postPeriodProcessing_(newPeriods, /* isPatchUpdate= */ true);
    }

    if (this.manifestPatchContext_.type == 'static') {
      const duration = this.manifestPatchContext_.mediaPresentationDuration;
      this.manifest_.presentationTimeline.setDuration(duration || Infinity);
    }
  }

  /**
   * Handles manifest type changes, this transition is expected to be
   * "dyanmic" to "static".
   * @param mpdType
   */
  private parsePatchMpdTypeChange_(mpdType: string) {
    this.manifest_.presentationTimeline.setStatic(mpdType == 'static');
    this.manifestPatchContext_.type = mpdType;
    for (const context of this.contextCache_.values()) {
      context.dynamic = mpdType == 'dynamic';
    }
    if (mpdType == 'static') {
      // Manifest is no longer dynamic, so stop live updates.
      this.updatePeriod_ = -1;
    }
  }

  /**
   *
   * @param durationString
   */
  private parsePatchMediaPresentationDurationChange_(durationString: string) {
    const duration = TXml.parseDuration(durationString);
    if (duration == null) {
      return;
    }
    this.manifestPatchContext_.mediaPresentationDuration = duration;
    for (const context of this.contextCache_.values()) {
      context.mediaPresentationDuration = duration;
    }
  }

  /**
   * Ingests a full MPD period element from a patch update
   * @param periods
   */
  private parsePatchPeriod_(periods: XmlNode) {
    asserts.assert(this.manifestPatchContext_.getBaseUris, 'Must provide getBaseUris on manifestPatchContext_');
    const context: DashParserContext = {
      dynamic: this.manifestPatchContext_.type == 'dynamic',
      presentationTimeline: this.manifest_.presentationTimeline,
      period: null,
      periodInfo: null,
      adaptationSet: null,
      representation: null,
      bandwidth: 0,
      indexRangeWarningGiven: false,
      availabilityTimeOffset: this.manifestPatchContext_.availabilityTimeOffset,
      profiles: this.manifestPatchContext_.profiles,
      mediaPresentationDuration: this.manifestPatchContext_.mediaPresentationDuration,
    };
    const periodsAndDuration = this.parsePeriods_(context, this.manifestPatchContext_.getBaseUris, periods);

    return periodsAndDuration.periods;
  }

  private removePatchPeriod_(periodId: string) {
    for (const contextId of this.contextCache_.keys()) {
      if (contextId.startsWith(periodId)) {
        const context = this.contextCache_.get(contextId)!;
        SegmentTemplate.removeTimepoints(context);
        this.parsePatchSegment_(contextId);
        this.contextCache_.delete(contextId);
      }
    }
  }

  private getContextIdsFromPath_(paths: TXmlPathNode[]) {
    let periodId = '';
    let adaptationSetId = '';
    let representationId = '';
    for (const node of paths) {
      if (node.name === 'Period') {
        periodId = node.id!;
      } else if (node.name === 'AdaptationSet') {
        adaptationSetId = node.id!;
      } else if (node.name === 'Representation') {
        representationId = node.id!;
      }
    }

    const contextIds = [];

    if (representationId) {
      contextIds.push(periodId + ',' + representationId);
    } else {
      for (const context of this.contextCache_.values()) {
        if (
          context.period!.id === periodId &&
          context.adaptationSet!.id === adaptationSetId &&
          context.representation!.id
        ) {
          contextIds.push(periodId + ',' + context.representation!.id);
        }
      }
    }
    return contextIds;
  }

  /**
   * Modifies SegmentTemplate based on MPD patch.
   * @param pathNode
   * @return context ids with updated timeline
   */
  private modifySegmentTemplate_(patchNode: XmlNode): string[] {
    const paths = TXml.parseXpath(patchNode.attributes['sel'] || '');
    const lastPath = paths[paths.length - 1];
    if (!lastPath.attribute) {
      return [];
    }

    const contextIds: string[] = this.getContextIdsFromPath_(paths);
    const content = TXml.getContents(patchNode) || '';

    for (const contextId of contextIds) {
      const context = this.contextCache_.get(contextId)!;
      asserts.assert(context && context.representation!.segmentTemplate, 'cannot modify segment template');
      TXml.modifyNodeAttribute(
        context.representation!.segmentTemplate!,
        patchNode.tagName,
        lastPath.attribute,
        content
      );
    }
    return contextIds;
  }

  /**
   * Ingests Patch MPD segments into timeline.
   * @param patchNode
   * @returns context ids with updated timeline
   */
  private modifyTimepoints_(patchNode: XmlNode): string[] {
    const paths = TXml.parseXpath(patchNode.attributes['sel'] || '');
    const contextIds = this.getContextIdsFromPath_(paths);

    for (const contextId of contextIds) {
      const context = this.contextCache_.get(contextId)!;
      SegmentTemplate.modifyTimepoints(context, patchNode);
    }
    return contextIds;
  }

  /**
   * Parses modified segments.
   * @param contextId
   */
  private parsePatchSegment_(contextId: string) {
    const context = this.contextCache_.get(contextId)!;

    const currentStream = this.streamMap_[contextId];
    asserts.assert(currentStream, 'stream should exist');

    if (currentStream.segmentIndex) {
      currentStream.segmentIndex.evict(this.manifest_.presentationTimeline.getSegmentAvailabilityStart());
    }

    try {
      const requestSegment = (uris: string[], startByte: number | null, endByte: number | null, isInit?: boolean) => {
        return this.requestSegment_(uris, startByte, endByte, isInit);
      };
      // TODO we should obtain lastSegmentNumber if possible
      const streamInfo = SegmentTemplate.createStreamInfo(
        context,
        requestSegment,
        this.streamMap_,
        /* isUpdate= */ true,
        this.config_.dash.initialSegmentLimit,
        this.periodDurations_,
        context.representation!.aesKey,
        /* lastSegmentNumber= */ null,
        /* isPatchUpdate= */ true
      );
      currentStream.createSegmentIndex = async () => {
        if (!currentStream.segmentIndex) {
          currentStream.segmentIndex = await streamInfo.generateSegmentIndex();
        }
      };
    } catch (error: any) {
      const ContentType = ManifestParserUtils.ContentType;
      const contentType = context.representation!.contentType;
      const isText = contentType == ContentType.TEXT || contentType == ContentType.APPLICATION;
      const isImage = contentType == ContentType.IMAGE;
      if (!(isText || isImage) || error.code != ShakaError.Code.DASH_NO_SEGMENT_INFO) {
        // We will ignore any DASH_NO_SEGMENT_INFO errors for text/image
        throw error;
      }
    }
  }

  /**
   * Reads maxLatency and maxPlaybackRate properties from service
   * description element.
   * @param mpd
   */
  parseServiceDescription_(mpd: XmlNode): ServiceDescription | null {
    const elem = TXml.findChild(mpd, 'ServiceDescription');

    if (!elem) {
      return null;
    }
    const latencyNode = TXml.findChild(elem, 'Latency');
    const playbackRateNode = TXml.findChild(elem, 'PlaybackRate');

    if (!latencyNode && !playbackRateNode) {
      return null;
    }

    const description = {} as ServiceDescription;

    if (latencyNode) {
      if ('target' in latencyNode.attributes) {
        description.targetLatency = parseInt(latencyNode.attributes['target'], 10) / 1000;
      }
      if ('max' in latencyNode.attributes) {
        description.maxLatency = parseInt(latencyNode.attributes['max'], 10) / 1000;
      }
      if ('min' in latencyNode.attributes) {
        description.minLatency = parseInt(latencyNode.attributes['min'], 10) / 1000;
      }
    }

    if (playbackRateNode) {
      if ('max' in playbackRateNode.attributes) {
        description.maxPlaybackRate = parseFloat(playbackRateNode.attributes['max']);
      }
      if ('min' in playbackRateNode.attributes) {
        description.minPlaybackRate = parseFloat(playbackRateNode.attributes['min']);
      }
    }

    return description;
  }

  /**
   * Reads chaining url.
   *
   * @param mpd
   * @return
   * @private
   */
  parseMpdChaining_(mpd: XmlNode) {
    const supplementalProperties = TXml.findChildren(mpd, 'SupplementalProperty');

    if (!supplementalProperties.length) {
      return null;
    }

    for (const prop of supplementalProperties) {
      const schemeId = prop.attributes['schemeIdUri'];
      if (schemeId == 'urn:mpeg:dash:chaining:2016') {
        return prop.attributes['value'];
      }
    }

    return null;
  }

  /**
   * Reads and parses the periods from the manifest.  This first does some
   * partial parsing so the start and duration is available when parsing
   * children.
   *
   * @param context
   * @param getBaseUris
   * @param mpd
   * @return
   * @private
   */
  private parsePeriods_(context: DashParserContext, getBaseUris: (() => string[]) | null, mpd: XmlNode) {
    let presentationDuration = context.mediaPresentationDuration;

    if (!presentationDuration) {
      presentationDuration = TXml.parseAttr(mpd, 'mediaPresentationDuration', TXml.parseDuration);
      this.manifestPatchContext_.mediaPresentationDuration = presentationDuration;
    }

    const periods: Period[] = [];
    let prevEnd = 0;
    const periodNodes = TXml.findChildren(mpd, 'Period');
    for (let i = 0; i < periodNodes.length; i++) {
      const elem = periodNodes[i];
      const next = periodNodes[i + 1];
      const start = TXml.parseAttr(elem, 'start', TXml.parseDuration, prevEnd) as number;
      const periodId = elem.attributes['id'];
      const givenDuration = TXml.parseAttr(elem, 'duration', TXml.parseDuration);

      let periodDuration = null;
      if (next) {
        // "The difference between the start time of a Period and the start time
        // of the following Period is the duration of the media content
        // represented by this Period."
        const nextStart = TXml.parseAttr(next, 'start', TXml.parseDuration);
        if (nextStart != null) {
          periodDuration = nextStart - start;
        }
      } else if (presentationDuration != null) {
        // "The Period extends until the Period.start of the next Period, or
        // until the end of the Media Presentation in the case of the last
        // Period."
        periodDuration = presentationDuration - start;
      }

      const threshold = ManifestParserUtils.GAP_OVERLAP_TOLERANCE_SECONDS;
      if (periodDuration && givenDuration && Math.abs(periodDuration - givenDuration) > threshold) {
        log.warning('There is a gap/overlap between Periods', elem);
      }
      // Only use the @duration in the MPD if we can't calculate it.  We should
      // favor the @start of the following Period.  This ensures that there
      // aren't gaps between Periods.
      if (periodDuration == null) {
        periodDuration = givenDuration;
      }

      /**
       * This is to improve robustness when the player observes manifest with
       * past periods that are inconsistent to previous ones.
       *
       * This may happen when a CDN or proxy server switches its upstream from
       * one encoder to another redundant encoder.
       *
       * Skip periods that match all of the following criteria:
       * - Start time is earlier than latest period start time ever seen
       * - Period ID is never seen in the previous manifest
       * - Not the last period in the manifest
       *
       * Periods that meet the aforementioned criteria are considered invalid
       * and should be safe to discard.
       */

      if (
        this.largestPeriodStartTime_ !== null &&
        periodId !== null &&
        start !== null &&
        start < this.largestPeriodStartTime_ &&
        !this.lastManifestUpdatePeriodIds_.includes(periodId) &&
        i + 1 != periodNodes.length
      ) {
        log.debug(
          `Skipping Period with ID ${periodId} as its start time is smaller` +
            ' than the largest period start time that has been seen, and ID ' +
            'is unseen before'
        );
        continue;
      }

      // Save maximum period start time if it is the last period
      if (start !== null && (this.largestPeriodStartTime_ === null || start > this.largestPeriodStartTime_)) {
        this.largestPeriodStartTime_ = start;
      }

      // Parse child nodes.
      const info = {
        start: start,
        duration: periodDuration,
        node: elem,
        isLastPeriod: periodDuration == null || !next,
      };
      const period = this.parsePeriod_(context, getBaseUris, info as any as DashParserPeriodInfo);
      periods.push(period);

      if (context.period!.id && periodDuration) {
        this.periodDurations_[context.period!.id] = periodDuration;
      }

      if (periodDuration == null) {
        if (next) {
          // If the duration is still null and we aren't at the end, then we
          // will skip any remaining periods.
          log.warning(
            'Skipping Period',
            i + 1,
            'and any subsequent Periods:',
            'Period',
            i + 1,
            'does not have a valid start time.',
            next
          );
        }

        // The duration is unknown, so the end is unknown.
        prevEnd = null as any;
        break;
      }

      prevEnd = start + periodDuration;
    } // end of period parsing loop

    // Replace previous seen periods with the current one.
    this.lastManifestUpdatePeriodIds_ = periods.map((el) => el.id);

    if (presentationDuration != null) {
      if (prevEnd != presentationDuration) {
        log.warning('@mediaPresentationDuration does not match the total duration of ', 'all Periods.');
        // Assume @mediaPresentationDuration is correct.
      }
      return {
        periods: periods,
        duration: presentationDuration,
        durationDerivedFromPeriods: false,
      };
    } else {
      return {
        periods: periods,
        duration: prevEnd,
        durationDerivedFromPeriods: true,
      };
    }
  }

  /**
   * Parses a Period XML element.  Unlike the other parse methods, this is not
   * given the Node; it is given a PeriodInfo structure.  Also, partial parsing
   * was done before this was called so start and duration are valid.
   *
   * @param context
   * @param getBaseUris
   * @param periodInfo
   * @return
   */
  private parsePeriod_(
    context: DashParserContext,
    getBaseUris: (() => string[]) | null,
    periodInfo: DashParserPeriodInfo
  ): Period {
    const ContentType = ManifestParserUtils.ContentType;

    context.period = this.createFrame_(periodInfo.node!, null, getBaseUris);
    context.periodInfo = periodInfo as any;
    context.period!.availabilityTimeOffset = context.availabilityTimeOffset;

    // If the period doesn't have an ID, give it one based on its start time.
    if (!context.period!.id) {
      log.info('No Period ID given for Period with start time ' + periodInfo.start + ',  Assigning a default');
      context!.period!.id = '__shaka_period_' + periodInfo.start;
    }

    const eventStreamNodes = TXml.findChildren(periodInfo.node, 'EventStream');
    const availabilityStart = context.presentationTimeline.getSegmentAvailabilityStart();

    for (const node of eventStreamNodes) {
      this.parseEventStream_(periodInfo.start, periodInfo.duration, node, availabilityStart);
    }

    const adaptationSetNodes = TXml.findChildren(periodInfo.node, 'AdaptationSet');
    const adaptationSets = adaptationSetNodes
      .map((node) => this.parseAdaptationSet_(context, node))
      .filter(Functional.isNotNull) as DashParserAdaptationInfo[];

    // For dynamic manifests, we use rep IDs internally, and they must be
    // unique.
    if (context.dynamic) {
      const ids = [];
      for (const set of adaptationSets) {
        for (const id of set.representationIds) {
          ids.push(id);
        }
      }

      const uniqueIds = new Set(ids);

      if (ids.length != uniqueIds.size) {
        throw new ShakaError(
          ShakaError.Severity.CRITICAL,
          ShakaError.Category.MANIFEST,
          ShakaError.Code.DASH_DUPLICATE_REPRESENTATION_ID
        );
      }
    }

    const normalAdaptationSets: DashParserAdaptationInfo[] = adaptationSets.filter((as) => {
      return !as.trickModeFor;
    });

    const trickModeAdaptationSets: DashParserAdaptationInfo[] = adaptationSets.filter((as) => {
      return as.trickModeFor;
    });

    // Attach trick mode tracks to normal tracks.
    for (const trickModeSet of trickModeAdaptationSets) {
      const targetIds = trickModeSet.trickModeFor!.split(' ');
      for (const normalSet of normalAdaptationSets) {
        if (targetIds.includes(normalSet.id)) {
          for (const stream of normalSet.streams) {
            // There may be multiple trick mode streams, but we do not
            // currently support that.  Just choose one.
            // TODO: https://github.com/shaka-project/shaka-player/issues/1528
            stream.trickModeVideo =
              trickModeSet.streams.find(
                (trickStream) =>
                  MimeUtils.getNormalizedCodec(stream.codecs) == MimeUtils.getNormalizedCodec(trickStream.codecs)
              ) || null;
          }
        }
      }
    }

    const audioStreams = this.getStreamsFromSets_(this.config_.disableAudio, normalAdaptationSets, ContentType.AUDIO);
    const videoStreams = this.getStreamsFromSets_(this.config_.disableVideo, normalAdaptationSets, ContentType.VIDEO);
    const textStreams = this.getStreamsFromSets_(this.config_.disableText, normalAdaptationSets, ContentType.TEXT);
    const imageStreams = this.getStreamsFromSets_(
      this.config_.disableThumbnails,
      normalAdaptationSets,
      ContentType.IMAGE
    );

    if (videoStreams.length === 0 && audioStreams.length === 0) {
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.MANIFEST,
        ShakaError.Code.DASH_EMPTY_PERIOD
      );
    }

    return {
      id: context.period!.id,
      audioStreams,
      videoStreams,
      textStreams,
      imageStreams,
    };
  }

  /**
   *  Gets the streams from the given sets or returns an empty array if disabled
   * or no streams are found.
   * @param disabled
   * @param adaptationSets
   * @param contentType
   * @returns
   */
  private getStreamsFromSets_(disabled: boolean, adaptationSets: DashParserAdaptationInfo[], contentType: string) {
    if (disabled || !adaptationSets.length) {
      return [];
    }

    return adaptationSets.reduce((all, part) => {
      if (part.contentType != contentType) {
        return all;
      }

      all.push(...part.streams);
      return all;
    }, [] as Stream[]);
  }

  /**
   * Parses an AdaptationSet XML element.
   * @param context
   * @param elem The AdaptationSet element.
   */
  private parseAdaptationSet_(context: DashParserContext, elem: XmlNode): DashParserAdaptationInfo | null {
    const ContentType = ManifestParserUtils.ContentType;

    context.adaptationSet = this.createFrame_(elem, context.period, null);

    let main = false;
    const roleElements = TXml.findChildren(elem, 'Role');
    const roleValues = roleElements
      .map((role) => {
        return role.attributes['value'];
      })
      .filter(Functional.isNotNull);

    // Default kind for text streams is 'subtitle' if unspecified in the
    // manifest.
    let kind: string;
    const isText = context.adaptationSet!.contentType == ContentType.TEXT;
    if (isText) {
      kind = ManifestParserUtils.TextStreamKind.SUBTITLE;
    }

    for (const roleElement of roleElements) {
      const scheme = roleElement.attributes['schemeIdUri'];
      if (scheme == null || scheme == 'urn:mpeg:dash:role:2011') {
        // These only apply for the given scheme, but allow them to be specified
        // if there is no scheme specified.
        // See: DASH section 5.8.5.5
        const value = roleElement.attributes['value'];
        switch (value) {
          case 'main':
            main = true;
            break;
          case 'caption':
          case 'subtitle':
            kind = value;
            break;
        }
      }
    }

    // Parallel for HLS VIDEO-RANGE as defined in DASH-IF IOP v4.3 6.2.5.1.
    let videoRange: string | undefined;

    let colorGamut: string | undefined;

    // Ref. https://dashif.org/docs/DASH-IF-IOP-v4.3.pdf
    // If signaled, a Supplemental or Essential Property descriptor
    // shall be used, with the schemeIdUri set to
    // urn:mpeg:mpegB:cicp:<Parameter> as defined in
    // ISO/IEC 23001-8 [49] and <Parameter> one of the
    // following: ColourPrimaries, TransferCharacteristics,
    // or MatrixCoefficients.
    const scheme = 'urn:mpeg:mpegB:cicp';
    const transferCharacteristicsScheme = `${scheme}:TransferCharacteristics`;
    const colourPrimariesScheme = `${scheme}:ColourPrimaries`;
    const matrixCoefficientsScheme = `${scheme}:MatrixCoefficients`;

    const getVideoRangeFromTransferCharacteristicCICP = (cicp: number) => {
      switch (cicp) {
        case 1:
        case 6:
        case 13:
        case 14:
        case 15:
          return 'SDR';
        case 16:
          return 'PQ';
        case 18:
          return 'HLG';
      }
      return undefined;
    };

    const getColorGamutFromColourPrimariesCICP = (cicp: number) => {
      switch (cicp) {
        case 1:
        case 5:
        case 6:
        case 7:
          return 'srgb';
        case 9:
          return 'rec2020';
        case 11:
        case 12:
          return 'p3';
      }
      return undefined;
    };

    const essentialProperties = TXml.findChildren(elem, 'EssentialProperty');
    // ID of real AdaptationSet if this is a trick mode set:
    let trickModeFor = null;
    let isFastSwitching = false;
    let unrecognizedEssentialProperty = false;
    for (const prop of essentialProperties) {
      const schemeId = prop.attributes['schemeIdUri'];
      if (schemeId == 'http://dashif.org/guidelines/trickmode') {
        trickModeFor = prop.attributes['value'];
      } else if (schemeId == transferCharacteristicsScheme) {
        videoRange = getVideoRangeFromTransferCharacteristicCICP(parseInt(prop.attributes['value'], 10));
      } else if (schemeId == colourPrimariesScheme) {
        colorGamut = getColorGamutFromColourPrimariesCICP(parseInt(prop.attributes['value'], 10));
      } else if (schemeId == matrixCoefficientsScheme) {
        continue;
      } else if (schemeId == 'urn:mpeg:dash:ssr:2023' && this.config_.dash.enableFastSwitching) {
        isFastSwitching = true;
      } else {
        unrecognizedEssentialProperty = true;
      }
    }

    let lastSegmentNumber: number;

    const supplementalProperties = TXml.findChildren(elem, 'SupplementalProperty');
    for (const prop of supplementalProperties) {
      const schemeId = prop.attributes['schemeIdUri'];
      if (schemeId == 'http://dashif.org/guidelines/last-segment-number') {
        lastSegmentNumber = parseInt(prop.attributes['value'], 10) - 1;
      } else if (schemeId == transferCharacteristicsScheme) {
        videoRange = getVideoRangeFromTransferCharacteristicCICP(parseInt(prop.attributes['value'], 10));
      } else if (schemeId == colourPrimariesScheme) {
        colorGamut = getColorGamutFromColourPrimariesCICP(parseInt(prop.attributes['value'], 10));
      }
    }
    const accessibilities = TXml.findChildren(elem, 'Accessibility');
    const closedCaptions = new Map();
    let accessibilityPurpose: AccessibilityPurpose;
    for (const prop of accessibilities) {
      const schemeId = prop.attributes['schemeIdUri'];
      const value = prop.attributes['value'];
      if (schemeId == 'urn:scte:dash:cc:cea-608:2015') {
        let channelId = 1;
        if (value != null) {
          const channelAssignments = value.split(';');
          for (const captionStr of channelAssignments) {
            let channel;
            let language;
            // Some closed caption descriptions have channel number and
            // language ("CC1=eng") others may only have language ("eng,spa").
            if (!captionStr.includes('=')) {
              // When the channel assignemnts are not explicitly provided and
              // there are only 2 values provided, it is highly likely that the
              // assignments are CC1 and CC3 (most commonly used CC streams).
              // Otherwise, cycle through all channels arbitrarily (CC1 - CC4)
              // in order of provided langs.
              channel = `CC${channelId}`;
              if (channelAssignments.length == 2) {
                channelId += 2;
              } else {
                channelId++;
              }
              language = captionStr;
            } else {
              const channelAndLanguage = captionStr.split('=');
              // The channel info can be '1' or 'CC1'.
              // If the channel info only has channel number(like '1'), add 'CC'
              // as prefix so that it can be a full channel id (like 'CC1').
              channel = channelAndLanguage[0].startsWith('CC') ? channelAndLanguage[0] : `CC${channelAndLanguage[0]}`;

              // 3 letters (ISO 639-2).  In b/187442669, we saw a blank string
              // (CC2=;CC3=), so default to "und" (the code for "undetermined").
              language = channelAndLanguage[1] || 'und';
            }
            closedCaptions.set(channel, LanguageUtils.normalize(language));
          }
        } else {
          // If channel and language information has not been provided, assign
          // 'CC1' as channel id and 'und' as language info.
          closedCaptions.set('CC1', 'und');
        }
      } else if (schemeId == 'urn:scte:dash:cc:cea-708:2015') {
        let serviceNumber = 1;
        if (value != null) {
          for (const captionStr of value.split(';')) {
            let service;
            let language;
            // Similar to CEA-608, it is possible that service # assignments
            // are not explicitly provided e.g. "eng;deu;swe" In this case,
            // we just cycle through the services for each language one by one.
            if (!captionStr.includes('=')) {
              service = `svc${serviceNumber}`;
              serviceNumber++;
              language = captionStr;
            } else {
              // Otherwise, CEA-708 caption values take the form "
              // 1=lang:eng;2=lang:deu" i.e. serviceNumber=lang:threelettercode.
              const serviceAndLanguage = captionStr.split('=');
              service = `svc${serviceAndLanguage[0]}`;

              // The language info can be different formats, lang:eng',
              // or 'lang:eng,war:1,er:1'. Extract the language info.
              language = serviceAndLanguage[1].split(',')[0].split(':').pop();
            }
            closedCaptions.set(service, LanguageUtils.normalize(language));
          }
        } else {
          // If service and language information has not been provided, assign
          // 'svc1' as service number and 'und' as language info.
          closedCaptions.set('svc1', 'und');
        }
      } else if (schemeId == 'urn:mpeg:dash:role:2011') {
        // See DASH IOP 3.9.2 Table 4.
        if (value != null) {
          roleValues.push(value);
          if (value == 'captions') {
            kind = ManifestParserUtils.TextStreamKind.CLOSED_CAPTION;
          }
        }
      } else if (schemeId == 'urn:tva:metadata:cs:AudioPurposeCS:2007') {
        // See DASH DVB Document A168 Rev.6 Table 5.
        if (value == '1') {
          accessibilityPurpose = AccessibilityPurpose.VISUALLY_IMPAIRED;
        } else if (value == '2') {
          accessibilityPurpose = AccessibilityPurpose.HARD_OF_HEARING;
        }
      }
    }

    // According to DASH spec (2014) section 5.8.4.8, "the successful processing
    // of the descriptor is essential to properly use the information in the
    // parent element".  According to DASH IOP v3.3, section 3.3.4, "if the
    // scheme or the value" for EssentialProperty is not recognized, "the DASH
    // client shall ignore the parent element."
    if (unrecognizedEssentialProperty) {
      // Stop parsing this AdaptationSet and let the caller filter out the
      // nulls.
      return null;
    }

    const contentProtectionElems = TXml.findChildren(elem, 'ContentProtection');
    const contentProtection = ContentProtection.parseFromAdaptationSet(
      contentProtectionElems,
      this.config_.dash.ignoreDrmInfo,
      this.config_.dash.keySystemsByURI
    );

    const language = LanguageUtils.normalize(context.adaptationSet!.language || 'und');

    // This attribute is currently non-standard, but it is supported by Kaltura.
    let label = elem.attributes['label'];

    // See DASH IOP 4.3 here https://dashif.org/docs/DASH-IF-IOP-v4.3.pdf (page 35)
    const labelElements = TXml.findChildren(elem, 'Label');
    if (labelElements && labelElements.length) {
      // NOTE: Right now only one label field is supported.
      const firstLabelElement = labelElements[0];
      const textContent = TXml.getTextContents(firstLabelElement);
      if (textContent) {
        label = textContent;
      }
    }

    // Parse Representations into Streams.
    const representations = TXml.findChildren(elem, 'Representation');
    const streams = representations
      .map((representation) => {
        const parsedRepresentation = this.parseRepresentation_(
          context,
          contentProtection,
          kind,
          language,
          label,
          main,
          roleValues,
          closedCaptions,
          representation,
          accessibilityPurpose,
          lastSegmentNumber
        );
        if (parsedRepresentation) {
          parsedRepresentation.hdr = parsedRepresentation.hdr || videoRange;
          parsedRepresentation.colorGamut = parsedRepresentation.colorGamut || colorGamut;
          parsedRepresentation.fastSwitching = isFastSwitching;
        }
        return parsedRepresentation;
      })
      .filter((s) => !!s) as Stream[];

    if (streams.length == 0) {
      const isImage = context.adaptationSet!.contentType == ContentType.IMAGE;
      // Ignore empty AdaptationSets if ignoreEmptyAdaptationSet is true
      // or they are for text/image content.
      if (this.config_.dash.ignoreEmptyAdaptationSet || isText || isImage) {
        return null;
      }
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.MANIFEST,
        ShakaError.Code.DASH_EMPTY_ADAPTATION_SET
      );
    }

    // If AdaptationSet's type is unknown or is ambiguously "application",
    // guess based on the information in the first stream.  If the attributes
    // mimeType and codecs are split across levels, they will both be inherited
    // down to the stream level by this point, so the stream will have all the
    // necessary information.
    if (!context.adaptationSet!.contentType || context.adaptationSet!.contentType == ContentType.APPLICATION) {
      const mimeType = streams[0].mimeType;
      const codecs = streams[0].codecs;
      context.adaptationSet!.contentType = DashParser.guessContentType_(mimeType, codecs);

      for (const stream of streams) {
        stream.type = context.adaptationSet!.contentType;
      }
    }

    const adaptationId = context.adaptationSet!.id || '__fake__' + this.globalId_++;

    for (const stream of streams) {
      // Some DRM license providers require that we have a default
      // key ID from the manifest in the wrapped license request.
      // Thus, it should be put in drmInfo to be accessible to request filters.
      for (const drmInfo of contentProtection.drmInfos) {
        drmInfo.keyIds =
          drmInfo.keyIds && stream.keyIds
            ? new Set([...drmInfo.keyIds, ...stream.keyIds])
            : drmInfo.keyIds || stream.keyIds;
      }
      if (this.config_.dash.enableAudioGroups) {
        stream.groupId = adaptationId;
      }
    }

    const repIds = representations
      .map((node) => {
        return node.attributes['id'];
      })
      .filter(Functional.isNotNull);

    return {
      id: adaptationId,
      contentType: context.adaptationSet!.contentType,
      language: language,
      main: main,
      streams: streams,
      drmInfos: contentProtection.drmInfos,
      trickModeFor: trickModeFor,
      representationIds: repIds,
    };
  }

  /**
   * Parses a Representation XML element.
   * @param context
   * @param contentProtection
   * @param kind
   * @param language
   * @param label
   * @param isPrimary
   * @param roles
   * @param closedCaptions
   * @param node
   * @param accessibilityPurpose
   * @param lastSegmentNumber
   */
  private parseRepresentation_(
    context: DashParserContext,
    contentProtection: ContentProtectionContext,
    kind: string | undefined,
    language: string,
    label: string,
    isPrimary: boolean,
    roles: string[],
    closedCaptions: Map<string, string>,
    node: XmlNode,
    accessibilityPurpose: AccessibilityPurpose,
    lastSegmentNumber: number
  ): Stream | null {
    const ContentType = ManifestParserUtils.ContentType;

    context.representation = this.createFrame_(node, context.adaptationSet, null);

    const representationId = context.representation!.id;

    this.minTotalAvailabilityTimeOffset_ = Math.min(
      this.minTotalAvailabilityTimeOffset_,
      context.representation!.availabilityTimeOffset
    );

    if (!this.verifyRepresentation_(context.representation)) {
      log.warning('Skipping Representation', context.representation);
      return null;
    }
    const periodStart = context.periodInfo!.start;

    // NOTE: bandwidth is a mandatory attribute according to the spec, and zero
    // does not make sense in the DASH spec's bandwidth formulas.
    // In some content, however, the attribute is missing or zero.
    // To avoid NaN at the variant level on broken content, fall back to zero.
    // https://github.com/shaka-project/shaka-player/issues/938#issuecomment-317278180
    context.bandwidth = TXml.parseAttr(node, 'bandwidth', TXml.parsePositiveInt) || 0;

    let streamInfo: DashParserStreamInfo;

    const contentType = context.representation!.contentType;
    const isText = contentType == ContentType.TEXT || contentType == ContentType.APPLICATION;
    const isImage = contentType == ContentType.IMAGE;

    try {
      let aesKey: AesKey | undefined = undefined;
      if (contentProtection.aes128Info) {
        const getBaseUris = context.representation!.getBaseUris;
        const uris = ManifestParserUtils.resolveUris(getBaseUris(), [contentProtection.aes128Info.keyUri]);
        const requestType = NetworkingEngineRequestType.KEY;
        const request = NetworkingEngine.makeRequest(uris, this.config_.retryParameters);
        aesKey = {
          bitsKey: 128,
          blockCipherMode: 'CBC',
          iv: contentProtection.aes128Info.iv,
          firstMediaSequenceNumber: 0,
        } as AesKey;

        // Don't download the key object until the segment is parsed, to
        // avoid a startup delay for long manifests with lots of keys.
        aesKey.fetchKey = async () => {
          const keyResponse = await this.makeNetworkRequest_(request, requestType);

          // keyResponse.status is undefined when URI is
          // "data:text/plain;base64,"
          if (!keyResponse.data || keyResponse.data.byteLength != 16) {
            throw new ShakaError(
              ShakaError.Severity.CRITICAL,
              ShakaError.Category.MANIFEST,
              ShakaError.Code.AES_128_INVALID_KEY_LENGTH
            );
          }

          const algorithm = {
            name: 'AES-CBC',
          };
          aesKey!.cryptoKey = await window.crypto.subtle.importKey('raw', keyResponse.data, algorithm, true, [
            'decrypt',
          ]);
          aesKey!.fetchKey = undefined; // No longer needed.
        };
      }

      context.representation!.aesKey = aesKey as AesKey;

      const requestSegment = (uris: string[], startByte: number | null, endByte: number | null, isInit?: boolean) => {
        return this.requestSegment_(uris, startByte, endByte, isInit);
      };

      if (context.representation!.segmentBase) {
        streamInfo = SegmentBase.createStreamInfo(context, requestSegment, aesKey as AesKey);
      } else if (context.representation!.segmentList) {
        streamInfo = SegmentList.createStreamInfo(context, this.streamMap_, aesKey);
      } else if (context.representation!.segmentTemplate) {
        const hasManifest = !!this.manifest_;

        streamInfo = SegmentTemplate.createStreamInfo(
          context,
          requestSegment,
          this.streamMap_,
          hasManifest,
          this.config_.dash.initialSegmentLimit,
          this.periodDurations_,
          aesKey as AesKey,
          lastSegmentNumber,
          /* isPatchUpdate= */ false
        );
      } else {
        asserts.assert(isText, 'Must have Segment* with non-text streams.');

        const duration = context.periodInfo!.duration || 0;
        const getBaseUris = context.representation!.getBaseUris;
        streamInfo = {
          generateSegmentIndex: () => {
            const segmentIndex = SegmentIndex.forSingleSegment(periodStart, duration, getBaseUris());
            segmentIndex.forEachTopLevelReference((ref) => {
              ref.mimeType = context.representation!.mimeType;
              ref.codecs = context.representation!.codecs;
            });
            return Promise.resolve(segmentIndex);
          },
        };
      }
    } catch (error: any) {
      if ((isText || isImage) && error.code == ShakaError.Code.DASH_NO_SEGMENT_INFO) {
        // We will ignore any DASH_NO_SEGMENT_INFO errors for text/image
        // streams.
        return null;
      }

      // For anything else, re-throw.
      throw error;
    }

    const contentProtectionElems = TXml.findChildren(node, 'ContentProtection');
    const keyId = ContentProtection.parseFromRepresentation(
      contentProtectionElems,
      contentProtection,
      this.config_.dash.ignoreDrmInfo,
      this.config_.dash.keySystemsByURI
    );
    const keyIds = new Set(keyId ? [keyId] : []);

    // Detect the presence of E-AC3 JOC audio content, using DD+JOC signaling.
    // See: ETSI TS 103 420 V1.2.1 (2018-10)
    const supplementalPropertyElems = TXml.findChildren(node, 'SupplementalProperty');

    const hasJoc = supplementalPropertyElems.some((element) => {
      const expectedUri = 'tag:dolby.com,2018:dash:EC3_ExtensionType:2018';
      const expectedValue = 'JOC';
      return element.attributes['schemeIdUri'] == expectedUri && element.attributes['value'] == expectedValue;
    });
    let spatialAudio = false;
    if (hasJoc) {
      spatialAudio = true;
    }

    let forced = false;
    if (isText) {
      // See: https://github.com/shaka-project/shaka-player/issues/2122 and
      // https://github.com/Dash-Industry-Forum/DASH-IF-IOP/issues/165
      forced = roles.includes('forced_subtitle') || roles.includes('forced-subtitle');
    }

    let tilesLayout;
    if (isImage) {
      const essentialPropertyElems = TXml.findChildren(node, 'EssentialProperty');
      const thumbnailTileElem = essentialPropertyElems.find((element) => {
        const expectedUris = ['http://dashif.org/thumbnail_tile', 'http://dashif.org/guidelines/thumbnail_tile'];
        return expectedUris.includes(element.attributes['schemeIdUri']);
      });
      if (thumbnailTileElem) {
        tilesLayout = thumbnailTileElem.attributes['value'];
      }
      // Filter image adaptation sets that has no tilesLayout.
      if (!tilesLayout) {
        return null;
      }
    }

    let hdr;
    const profiles = context.profiles;
    const codecs = context.representation!.codecs;

    const hevcHDR = 'http://dashif.org/guidelines/dash-if-uhd#hevc-hdr-pq10';
    if (profiles.includes(hevcHDR) && (codecs.includes('hvc1.2.4.L153.B0') || codecs.includes('hev1.2.4.L153.B0'))) {
      hdr = 'PQ';
    }

    const contextId = context.representation!.id ? context.period!.id + ',' + context.representation!.id : '';

    if (this.patchLocationNodes_.length && representationId) {
      this.contextCache_.set(`${context.period!.id},${representationId}`, this.cloneContext_(context));
    }

    let stream: Stream;

    if (contextId && this.streamMap_[contextId]) {
      stream = this.streamMap_[contextId];
    } else {
      stream = {
        id: this.globalId_++,
        originalId: context.representation!.id,
        groupId: null,
        createSegmentIndex: () => Promise.resolve(),
        closeSegmentIndex: () => {
          if (stream.segmentIndex) {
            stream.segmentIndex.release();
            stream.segmentIndex = null;
          }
        },
        segmentIndex: null,
        mimeType: context.representation!.mimeType,
        codecs,
        frameRate: context.representation!.frameRate,
        pixelAspectRatio: context.representation!.pixelAspectRatio,
        bandwidth: context.bandwidth,
        width: context.representation!.width,
        height: context.representation!.height,
        kind,
        encrypted: contentProtection.drmInfos.length > 0,
        drmInfos: contentProtection.drmInfos,
        keyIds,
        language,
        originalLanguage: context.adaptationSet!.language,
        label,
        type: context.adaptationSet!.contentType,
        primary: isPrimary,
        trickModeVideo: null,
        emsgSchemeIdUris: context.representation!.emsgSchemeIdUris,
        roles,
        forced,
        channelsCount: context.representation!.numChannels,
        audioSamplingRate: context.representation!.audioSamplingRate,
        spatialAudio,
        closedCaptions,
        hdr,
        colorGamut: undefined,
        videoLayout: undefined,
        tilesLayout,
        accessibilityPurpose,
        external: false,
        fastSwitching: false,
        fullMimeTypes: new Set([
          MimeUtils.getFullType(context.representation!.mimeType, context.representation!.codecs),
        ]),
      };
    }

    stream.createSegmentIndex = async () => {
      if (!stream.segmentIndex) {
        stream.segmentIndex = await streamInfo.generateSegmentIndex();
      }
    };

    if (contextId && context.dynamic && !this.streamMap_[contextId]) {
      this.streamMap_[contextId] = stream;
    }

    return stream;
  }

  /**
   * Clone context and remove xml document references.
   * @param context
   */
  private cloneContext_(context: DashParserContext): DashParserContext {
    const contextClone = {} as Record<string, any | null>;

    for (const k of Object.keys(context)) {
      if (['period', 'adaptationSet', 'representation'].includes(k)) {
        // @ts-expect-error
        const frameRef: DashParserInheritanceFrame = context[k];
        contextClone[k] = {
          segmentBase: null,
          segmentList: null,
          segmentTemplate: frameRef.segmentTemplate,
          getBaseUris: frameRef.getBaseUris,
          width: frameRef.width,
          height: frameRef.height,
          contentType: frameRef.contentType,
          mimeType: frameRef.mimeType,
          language: frameRef.language,
          codecs: frameRef.codecs,
          frameRate: frameRef.frameRate,
          pixelAspectRatio: frameRef.pixelAspectRatio,
          emsgSchemeIdUris: frameRef.emsgSchemeIdUris,
          id: frameRef.id,
          numChannels: frameRef.numChannels,
          audioSamplingRate: frameRef.audioSamplingRate,
          availabilityTimeOffset: frameRef.availabilityTimeOffset,
          initialization: frameRef.initialization,
        };
      } else if (k == 'periodInfo') {
        // @ts-expect-error
        const frameRef: DashParserPeriodInfo = context[k];
        contextClone[k] = {
          start: frameRef.start,
          duration: frameRef.duration,
          node: null,
          isLastPeriod: frameRef.isLastPeriod,
        };
      } else {
        // @ts-expect-error
        contextClone[k] = context[k];
      }
    }

    return contextClone as DashParserContext;
  }

  /**
   * Called when the update timer ticks.
   *
   */
  private async onUpdate_() {
    asserts.assert(this.updatePeriod_ >= 0, 'There should be an update period');

    log.info('Updating manifest...');

    // Default the update delay to 0 seconds so that if there is an error we can
    // try again right away.
    let updateDelay = 0;

    try {
      updateDelay = await this.requestManifest_();
    } catch (error: any) {
      asserts.assert(error instanceof ShakaError, 'Should only receive a Shaka error');

      // Try updating again, but ensure we haven't been destroyed.
      if (this.playerInterface_) {
        if (this.config_.raiseFatalErrorOnManifestUpdateRequestFailure) {
          this.playerInterface_.onError(error);
          return;
        }
        // We will retry updating, so override the severity of the error.
        error.severity = ShakaError.Severity.RECOVERABLE;
        this.playerInterface_.onError(error);
      }
    }

    // Detect a call to stop()
    if (!this.playerInterface_) {
      return;
    }

    this.playerInterface_.onManifestUpdated();

    this.setUpdateTimer_(updateDelay);
  }

  /**
   * Update now the manifest
   *
   */
  private updateNow_() {
    this.updateTimer_.tickNow();
  }

  /**
   * Sets the update timer.  Does nothing if the manifest does not specify an
   * update period.
   *
   * @param offset An offset, in seconds, to apply to the manifest's
   *   update period.
   */
  private setUpdateTimer_(offset: number) {
    // NOTE: An updatePeriod_ of -1 means the attribute was missing.
    // An attribute which is present and set to 0 should still result in
    // periodic updates.  For more, see:
    // https://github.com/Dash-Industry-Forum/Guidelines-TimingModel/issues/48
    if (this.updatePeriod_ < 0) {
      return;
    }
    let updateTime = this.updatePeriod_;
    if (this.config_.dash.updatePeriod >= 0) {
      updateTime = this.config_.dash.updatePeriod;
    }

    const finalDelay = Math.max(updateTime - offset, this.averageUpdateDuration_.getEstimate());

    // We do not run the timer as repeating because part of update is async and
    // we need schedule the update after it finished.
    this.updateTimer_.tickAfter(/* seconds= */ finalDelay);
  }

  /**
   * Creates a new inheritance frame for the given element.
   * @param elem
   * @param parent
   * @param getBaseUris
   */
  createFrame_(
    elem: XmlNode,
    parent: DashParserInheritanceFrame | null,
    getBaseUris: (() => string[]) | null
  ): DashParserInheritanceFrame {
    asserts.assert(parent || getBaseUris, 'Must provide either parent or getBaseUris');

    const SCTE214 = DashParser.SCTE214_;

    parent =
      parent ||
      ({
        contentType: '',
        mimeType: '',
        codecs: '',
        emsgSchemeIdUris: [],
        frameRate: undefined,
        pixelAspectRatio: undefined,
        numChannels: null,
        audioSamplingRate: null,
        availabilityTimeOffset: 0,
        segmentSequenceCadence: 0,
      } as any as DashParserInheritanceFrame);
    getBaseUris = getBaseUris || parent.getBaseUris;
    getBaseUris = getBaseUris || parent.getBaseUris;

    const parseNumber = TXml.parseNonNegativeInt;
    const evalDivision = TXml.evalDivision;

    const id = elem.attributes['id'];
    const uriObjs = TXml.findChildren(elem, 'BaseURL');
    let calculatedBaseUris: string[];
    let someLocationValid = false;
    if (this.contentSteeringManager_) {
      for (const uriObj of uriObjs) {
        const serviceLocation = uriObj.attributes['serviceLocation'];
        const uri = TXml.getContents(uriObj);
        if (serviceLocation && uri) {
          this.contentSteeringManager_.addLocation(id, serviceLocation, uri);
          someLocationValid = true;
        }
      }
    }

    if (!someLocationValid || !this.contentSteeringManager_) {
      calculatedBaseUris = uriObjs.map(TXml.getContents) as string[];
    }

    const getFrameUris = () => {
      if (!uriObjs.length) {
        return [];
      }
      if (this.contentSteeringManager_ && someLocationValid) {
        return this.contentSteeringManager_.getLocations(id);
      }
      if (calculatedBaseUris) {
        return calculatedBaseUris;
      }
      return [];
    };

    let contentType = elem.attributes['contentType'] || parent.contentType;
    const mimeType = elem.attributes['mimeType'] || parent.mimeType;
    const allCodecs = [elem.attributes['codecs'] || parent.codecs];
    const supplementalCodecs = TXml.getAttributeNS(elem, SCTE214, 'supplementalCodecs');
    if (supplementalCodecs) {
      allCodecs.push(supplementalCodecs);
    }
    const codecs = SegmentUtils.codecsFiltering(allCodecs).join(',');
    const frameRate = TXml.parseAttr(elem, 'frameRate', evalDivision) || parent.frameRate;
    const pixelAspectRatio = elem.attributes['sar'] || parent.pixelAspectRatio;
    const emsgSchemeIdUris = this.emsgSchemeIdUris_(
      TXml.findChildren(elem, 'InbandEventStream'),
      parent.emsgSchemeIdUris
    );
    const audioChannelConfigs = TXml.findChildren(elem, 'AudioChannelConfiguration');
    const numChannels = this.parseAudioChannels_(audioChannelConfigs) || parent.numChannels;
    const audioSamplingRate = TXml.parseAttr(elem, 'audioSamplingRate', parseNumber) || parent.audioSamplingRate;

    if (!contentType) {
      contentType = DashParser.guessContentType_(mimeType, codecs);
    }

    const segmentBase = TXml.findChild(elem, 'SegmentBase');
    const segmentTemplate = TXml.findChild(elem, 'SegmentTemplate');

    // The availabilityTimeOffset is the sum of all @availabilityTimeOffset
    // values that apply to the adaptation set, via BaseURL, SegmentBase,
    // or SegmentTemplate elements.
    const segmentBaseAto = segmentBase
      ? TXml.parseAttr(segmentBase, 'availabilityTimeOffset', TXml.parseFloat) || 0
      : 0;
    const segmentTemplateAto = segmentTemplate
      ? TXml.parseAttr(segmentTemplate, 'availabilityTimeOffset', TXml.parseFloat) || 0
      : 0;
    const baseUriAto =
      uriObjs && uriObjs.length ? TXml.parseAttr(uriObjs[0], 'availabilityTimeOffset', TXml.parseFloat) || 0 : 0;

    const availabilityTimeOffset = parent.availabilityTimeOffset + baseUriAto + segmentBaseAto + segmentTemplateAto;

    let segmentSequenceCadence = null;
    const segmentSequenceProperties = TXml.findChild(elem, 'SegmentSequenceProperties');
    if (segmentSequenceProperties) {
      const sap = TXml.findChild(segmentSequenceProperties, 'SAP');
      if (sap) {
        segmentSequenceCadence = TXml.parseAttr(sap, 'cadence', TXml.parseInt);
      }
    }

    return {
      getBaseUris: () => ManifestParserUtils.resolveUris(getBaseUris(), getFrameUris()),
      segmentBase: segmentBase || parent.segmentBase,
      segmentList: TXml.findChild(elem, 'SegmentList') || parent.segmentList,
      segmentTemplate: segmentTemplate || parent.segmentTemplate,
      width: TXml.parseAttr(elem, 'width', parseNumber) || parent.width,
      height: TXml.parseAttr(elem, 'height', parseNumber) || parent.height,
      contentType: contentType,
      mimeType: mimeType,
      codecs: codecs,
      frameRate: frameRate,
      pixelAspectRatio: pixelAspectRatio,
      emsgSchemeIdUris: emsgSchemeIdUris,
      id: id,
      language: elem.attributes['lang'],
      numChannels: numChannels,
      audioSamplingRate: audioSamplingRate,
      availabilityTimeOffset: availabilityTimeOffset,
      initialization: null,
      segmentSequenceCadence: segmentSequenceCadence || parent.segmentSequenceCadence,
      aesKey: null,
    };
  }

  /**
   * Returns a new array of InbandEventStream schemeIdUri containing the union
   * of the ones parsed from inBandEventStreams and the ones provided in
   * emsgSchemeIdUris.
   * @param inBandEventStreams Array of InbandEventStream
   *     elements to parse and add to the returned array.
   * @param emsgSchemeIdUris  Array of parsed
   *     InbandEventStream schemeIdUri attributes to add to the returned array.
   * @returns schemeIdUris Array of parsed
   *     InbandEventStream schemeIdUri attributes.
   */
  emsgSchemeIdUris_(inBandEventStreams: XmlNode[], emsgSchemeIdUris: string[]) {
    const schemeIdUris = emsgSchemeIdUris.slice();
    for (const event of inBandEventStreams) {
      const schemeIdUri = event.attributes['schemeIdUri'];
      if (!schemeIdUris.includes(schemeIdUri)) {
        schemeIdUris.push(schemeIdUri);
      }
    }
    return schemeIdUris;
  }

  /**
   * @param audioChannelConfigs An array of
   *   AudioChannelConfiguration elements.
   * @return The number of audio channels, or null if unknown.
   * @private
   */
  parseAudioChannels_(audioChannelConfigs: XmlNode[]): number | null {
    for (const elem of audioChannelConfigs) {
      const scheme = elem.attributes['schemeIdUri'];
      if (!scheme) {
        continue;
      }

      const value: string = elem.attributes['value'];
      if (!value) {
        continue;
      }

      switch (scheme) {
        case 'urn:mpeg:dash:outputChannelPositionList:2012':
          // A space-separated list of speaker positions, so the number of
          // channels is the length of this list.
          return value.trim().split(/ +/).length;

        case 'urn:mpeg:dash:23003:3:audio_channel_configuration:2011':
        case 'urn:dts:dash:audio_channel_configuration:2012': {
          // As far as we can tell, this is a number of channels.
          const intValue = parseInt(value, 10);
          if (!intValue) {
            // 0 or NaN
            log.warning('Channel parsing failure! ' + 'Ignoring scheme and value', scheme, value);
            continue;
          }
          return intValue;
        }

        case 'tag:dolby.com,2014:dash:audio_channel_configuration:2011':
        case 'urn:dolby:dash:audio_channel_configuration:2011': {
          // A hex-encoded 16-bit integer, in which each bit represents a
          // channel.
          let hexValue = parseInt(value, 16);
          if (!hexValue) {
            // 0 or NaN
            log.warning('Channel parsing failure! ' + 'Ignoring scheme and value', scheme, value);
            continue;
          }
          // Count the 1-bits in hexValue.
          let numBits = 0;
          while (hexValue) {
            if (hexValue & 1) {
              ++numBits;
            }
            hexValue >>= 1;
          }
          return numBits;
        }

        // Defined by https://dashif.org/identifiers/audio_source_metadata/ and clause 8.2, in ISO/IEC 23001-8.
        case 'urn:mpeg:mpegB:cicp:ChannelConfiguration': {
          const noValue = 0;
          const channelCountMapping = [
            noValue,
            1,
            2,
            3,
            4,
            5,
            6,
            8,
            2,
            3 /* 0--9 */,
            4,
            7,
            8,
            24,
            8,
            12,
            10,
            12,
            14,
            12 /* 10--19 */,
            14 /* 20 */,
          ];
          const intValue = parseInt(value, 10);
          if (!intValue) {
            // 0 or NaN
            log.warning('Channel parsing failure! ' + 'Ignoring scheme and value', scheme, value);
            continue;
          }
          if (intValue > noValue && intValue < channelCountMapping.length) {
            return channelCountMapping[intValue];
          }
          continue;
        }

        default:
          log.warning('Unrecognized audio channel scheme:', scheme, value);
          continue;
      }
    }

    return null;
  }

  /**
   * Verifies that a Representation has exactly one Segment* element.  Prints
   * warnings if there is a problem.
   *
   * @param {dash.DashParser.InheritanceFrame} frame
   * @return {boolean} True if the Representation is usable; otherwise return
   *   false.
   * @private
   */
  verifyRepresentation_(frame: DashParserInheritanceFrame) {
    const ContentType = ManifestParserUtils.ContentType;

    let n = 0;
    n += frame.segmentBase ? 1 : 0;
    n += frame.segmentList ? 1 : 0;
    n += frame.segmentTemplate ? 1 : 0;

    if (n == 0) {
      // TODO: Extend with the list of MIME types registered to TextEngine.
      if (frame.contentType == ContentType.TEXT || frame.contentType == ContentType.APPLICATION) {
        return true;
      } else {
        log.warning(
          'Representation does not contain a segment information source:',
          'the Representation must contain one of SegmentBase, SegmentList,',
          'SegmentTemplate, or explicitly indicate that it is "text".',
          frame
        );
        return false;
      }
    }

    if (n != 1) {
      log.warning(
        'Representation contains multiple segment information sources:',
        'the Representation should only contain one of SegmentBase,',
        'SegmentList, or SegmentTemplate.',
        frame
      );
      if (frame.segmentBase) {
        log.info('Using SegmentBase by default.');
        frame.segmentList = null;
        frame.segmentTemplate = null;
      } else {
        asserts.assert(frame.segmentList, 'There should be a SegmentList');
        log.info('Using SegmentList by default.');
        frame.segmentTemplate = null;
      }
    }

    return true;
  }

  /**
   * Makes a request to the given URI and calculates the clock offset.
   *
   * @param getBaseUris
   * @param uri
   * @param method
   * @return
   * @private
   */
  async requestForTiming_(getBaseUris: () => string[], uri: string, method: string) {
    const uris = [StringUtils.htmlUnescape(uri)];
    const requestUris = ManifestParserUtils.resolveUris(getBaseUris(), uris);
    const request = NetworkingEngine.makeRequest(requestUris, this.config_.retryParameters);
    request.method = method;
    const type = NetworkingEngineRequestType.TIMING;

    const operation = this.playerInterface_.networkingEngine.request(type, request);
    this.operationManager_.manage(operation);

    const response = await operation.promise;
    let text;
    if (method == 'HEAD') {
      if (!response.headers || !response.headers['date']) {
        log.warning('UTC timing response is missing', 'expected date header');
        return 0;
      }
      text = response.headers['date'];
    } else {
      text = StringUtils.fromUTF8(response.data);
    }
    const date = Date.parse(text);
    if (isNaN(date)) {
      log.warning('Unable to parse date from UTC timing response');
      return 0;
    }
    return date - Date.now();
  }

  /**
   * Parses an array of UTCTiming elements.
   *
   * @param getBaseUris
   * @param elems
   * @return
   * @private
   */
  async parseUtcTiming_(getBaseUris: () => string[], elems: XmlNode[]) {
    const schemesAndValues = elems.map((elem) => {
      return {
        scheme: elem.attributes['schemeIdUri'],
        value: elem.attributes['value'],
      };
    });

    // If there's nothing specified in the manifest, but we have a default from
    // the config, use that.
    const clockSyncUri = this.config_.dash.clockSyncUri;
    if (!schemesAndValues.length && clockSyncUri) {
      schemesAndValues.push({
        scheme: 'urn:mpeg:dash:utc:http-head:2014',
        value: clockSyncUri,
      });
    }

    for (const sv of schemesAndValues) {
      try {
        const scheme = sv.scheme;
        const value = sv.value;
        switch (scheme) {
          // See DASH IOP Guidelines Section 4.7
          // https://bit.ly/DashIop3-2
          // Some old ISO23009-1 drafts used 2012.
          case 'urn:mpeg:dash:utc:http-head:2014':
          case 'urn:mpeg:dash:utc:http-head:2012':
            // eslint-disable-next-line no-await-in-loop
            return await this.requestForTiming_(getBaseUris, value, 'HEAD');
          case 'urn:mpeg:dash:utc:http-xsdate:2014':
          case 'urn:mpeg:dash:utc:http-iso:2014':
          case 'urn:mpeg:dash:utc:http-xsdate:2012':
          case 'urn:mpeg:dash:utc:http-iso:2012':
            // eslint-disable-next-line no-await-in-loop
            return await this.requestForTiming_(getBaseUris, value, 'GET');
          case 'urn:mpeg:dash:utc:direct:2014':
          case 'urn:mpeg:dash:utc:direct:2012': {
            const date = Date.parse(value);
            return isNaN(date) ? 0 : date - Date.now();
          }

          case 'urn:mpeg:dash:utc:http-ntp:2014':
          case 'urn:mpeg:dash:utc:ntp:2014':
          case 'urn:mpeg:dash:utc:sntp:2014':
            log.alwaysWarn('NTP UTCTiming scheme is not supported');
            break;
          default:
            log.alwaysWarn('Unrecognized scheme in UTCTiming element', scheme);
            break;
        }
      } catch (e: any) {
        log.warning('Error fetching time from UTCTiming elem', e.message);
      }
    }

    log.alwaysWarn(
      'A UTCTiming element should always be given in live manifests! ' +
        'This content may not play on clients with bad clocks!'
    );
    return 0;
  }

  /**
   * Parses an EventStream element.
   *
   * @param periodStart
   * @param periodDuration
   * @param elem
   * @param availabilityStart
   * @private
   */
  parseEventStream_(periodStart: number, periodDuration: number | null, elem: XmlNode, availabilityStart: number) {
    const parseNumber = TXml.parseNonNegativeInt;

    const schemeIdUri = elem.attributes['schemeIdUri'] || '';
    const value = elem.attributes['value'] || '';
    const timescale = TXml.parseAttr(elem, 'timescale', parseNumber) || 1;

    for (const eventNode of TXml.findChildren(elem, 'Event')) {
      const presentationTime = TXml.parseAttr(eventNode, 'presentationTime', parseNumber) || 0;
      const duration = TXml.parseAttr(eventNode, 'duration', parseNumber) || 0;

      let startTime = presentationTime / timescale + periodStart;
      let endTime = startTime + duration / timescale;
      if (periodDuration != null) {
        // An event should not go past the Period, even if the manifest says so.
        // See: Dash sec. 5.10.2.1
        startTime = Math.min(startTime, periodStart + periodDuration);
        endTime = Math.min(endTime, periodStart + periodDuration);
      }

      // Don't add unavailable regions to the timeline.
      if (endTime < availabilityStart) {
        continue;
      }

      const region: TimelineRegionInfo = {
        schemeIdUri: schemeIdUri,
        value: value,
        startTime: startTime,
        endTime: endTime,
        id: eventNode.attributes['id'] || '',
        eventElement: TXml.txmlNodeToDomElement(eventNode),
        eventNode: eventNode,
      };

      this.playerInterface_.onTimelineRegionAdded(region);
    }
  }

  async requestSegment_(
    uris: string[],
    startByte: number | null,
    endByte: number | null,
    isInit?: boolean
  ): Promise<BufferSource> {
    const requestType = NetworkingEngineRequestType.SEGMENT;
    const type = isInit
      ? NetworkingEngineAdvancedRequestType.INIT_SEGMENT
      : NetworkingEngineAdvancedRequestType.MEDIA_SEGMENT;

    const request = Networking.createSegmentRequest(uris, startByte, endByte, this.config_.retryParameters);

    const response = await this.makeNetworkRequest_(request, requestType, { type });
    return response.data;
  }

  /**
   * Guess the content type based on MIME type and codecs.
   *
   * @param {string} mimeType
   * @param {string} codecs
   * @return {string}
   * @private
   */
  static guessContentType_(mimeType: string, codecs: string) {
    const fullMimeType = MimeUtils.getFullType(mimeType, codecs);

    if (TextEngine.isTypeSupported(fullMimeType)) {
      // If it's supported by TextEngine, it's definitely text.
      // We don't check MediaSourceEngine, because that would report support
      // for platform-supported video and audio types as well.
      return ManifestParserUtils.ContentType.TEXT;
    }

    // Otherwise, just split the MIME type.  This handles video and audio
    // types well.
    return mimeType.split('/')[0];
  }

  /**
   * Create a networking request. This will manage the request using the
   * parser's operation manager.
   *
   * @param request
   * @param type
   * @param context
   * @return
   * @private
   */
  makeNetworkRequest_(request: Request, type: NetworkingEngineRequestType, context?: RequestContext) {
    const op = this.playerInterface_.networkingEngine.request(type, request, context);
    this.operationManager_.manage(op);
    return op.promise;
  }

  updatePatchLocationNodes_(patchNode: XmlNode) {
    TXml.modifyNodes(this.patchLocationNodes_, patchNode);
  }

  getPatchLocationUris_() {
    const mpdId = this.manifestPatchContext_.mpdId;
    const publishTime = this.manifestPatchContext_.publishTime;
    if (!mpdId || !publishTime || !this.patchLocationNodes_.length) {
      return [];
    }
    const now = Date.now() / 1000;
    const patchLocations = this.patchLocationNodes_
      .filter((patchLocation) => {
        const ttl = TXml.parseNonNegativeInt(patchLocation.attributes['ttl']);
        return !ttl || publishTime + ttl > now;
      })
      .map(TXml.getContents)
      .filter(Functional.isNotNull) as string[];

    if (!patchLocations.length) {
      return [];
    }
    return ManifestParserUtils.resolveUris(this.manifestUris_, patchLocations);
  }
}

export interface DashParserPatchContext {
  // ID of the original MPD file.
  mpdId: string;
  // Specifies the type of the dash manifest i.e. "static"
  type: string;
  // Media presentation duration, or null if unknown.
  mediaPresentationDuration: number | null;
  /**
   * Profiles of DASH are defined to enable interoperability and the
   * signaling of the use of features.
   */
  profiles: string[];
  // Specifies the total availabilityTimeOffset of the segment.
  availabilityTimeOffset: number;
  // An array of absolute base URIs.
  getBaseUris: (() => string[]) | null;
  // Time when manifest has been published, in seconds.
  publishTime: number;
}

export type DashParserRequestSegmentCallback = (
  uris: string[],
  startByte: number | null,
  endByte: number | null,
  isInit?: boolean
) => Promise<BufferSource>;

/**
 * A collection of elements and properties which are inherited across levels
 * of a DASH manifest.
 */

export interface DashParserInheritanceFrame {
  // The XML node for SegmentBase.
  segmentBase: XmlNode | null;
  // The XML node for SegmentList.
  segmentList: XmlNode | null;
  // The XML node for SegmentTemplate.
  segmentTemplate: XmlNode | null;
  // Function than returns an array of absolute base URIs for the frame.
  getBaseUris: () => string[];
  // The inherited width value.
  width?: number;
  // The inherited height value.
  height?: number;
  // The inherited media type.
  mimeType: string;
  // The inherited media type.
  contentType: string;
  // The inherited codecs value.
  codecs: string;
  // The inherited framerate value.
  frameRate?: number;
  // The inherited pixel aspect ratio value.
  pixelAspectRatio?: string;

  // The inherited pixel aspect ratio value.
  emsgSchemeIdUris: string[];
  // The ID of the element.
  id: string | null;
  // The original language of the element.
  language: string | null;
  // The number of audio channels, or null if unknown.
  numChannels: number | null;
  // Specifies the maximum sampling rate of the content, or null if unknown.
  audioSamplingRate: number | null;
  // Specifies the total availabilityTimeOffset of the segment, or 0 if unknown.
  availabilityTimeOffset: number;
  // Specifies the file where the init segment is located, or null.
  initialization?: string | null;
  // AES-128 Content protection key
  aesKey: AesKey | null;
  /**
   * Specifies the cadence of independent segments in Segment Sequence
   * Representation.
   */
  segmentSequenceCadence: number;
}

/**
 * @description
 * Contains context data for the streams.  This is designed to be
 * shallow-copyable, so the parser must overwrite (not modify) each key as the
 * parser moves through the manifest and the parsing context changes.
 *
 */
export interface DashParserContext {
  // True if the MPD is dynamic (not all segments available at once)
  dynamic: boolean;
  // The PresentationTimeline.
  presentationTimeline: PresentationTimeline;
  period: DashParserInheritanceFrame | null;
  // The Period info for the current Period.
  periodInfo: DashParserPeriodInfo | null;
  //  The inheritance from the AdaptationSet element.
  adaptationSet: DashParserInheritanceFrame | null;
  // The inheritance from the Representation element.
  representation: DashParserInheritanceFrame | null;
  // The bandwidth of the Representation, or zero if missing.
  bandwidth: number;
  // True if the warning about SegmentURL@indexRange has been printed.
  indexRangeWarningGiven: boolean;
  //  The sum of the availabilityTimeOffset values that apply to the element.
  availabilityTimeOffset: number;
  /**
   * Profiles of DASH are defined to enable interoperability and the signaling
   * of the use of features.
   */
  profiles: string[];
  //  Media presentation duration, or null if unknown.
  mediaPresentationDuration?: number | null;
}

/**
 * @description
 * Contains information about a Period element.
 */
export interface DashParserPeriodInfo {
  // The start time of the period.
  start: number;
  /**
   * The duration of the period; or null if the duration is not given.  This
   * will be non-null for all periods except the last.
   */
  duration: number | null;
  // The XML Node for the Period.
  node: XmlNode;
  // Whether this Period is the last one in the manifest.
  isLastPeriod: boolean;
}

export interface DashParserAdaptationInfo {
  // The unique ID of the adaptation set.
  id: string;
  // The content type of the AdaptationSet.
  contentType: string;
  //  The language of the AdaptationSet.
  language: string;
  //  Whether the AdaptationSet has the 'main' type.
  main: boolean;
  //  The streams this AdaptationSet contains.
  streams: Stream[];
  // The DRM info for the AdaptationSet.
  drmInfos: DrmInfo[];
  /**
   * If non-null, this AdaptationInfo represents trick mode tracks.  This
   * property is the ID of the normal AdaptationSet these tracks should be
   * associated with.
   */
  trickModeFor?: string;
  // An array of the IDs of the Representations this AdaptationSet contains.
  representationIds: string[];
}

// An async function which generates and returns a SegmentIndex.
export type DashParserGenerateSegmentIndexFunction = () => Promise<SegmentIndex>;

/**
 * Contains information about a Stream. This is passed from the createStreamInfo
 * methods.
 */
export interface DashParserStreamInfo {
  // An async function to create the SegmentIndex for the stream.
  generateSegmentIndex: DashParserGenerateSegmentIndexFunction;
}

export type GetFrameNode = (frame: DashParserInheritanceFrame | null) => XmlNode | undefined;
export const registerDashParser = () => {
  ManifestParser.registerParserByMime('application/dash+xml', () => new DashParser());
  ManifestParser.registerParserByMime('video/vnd.mpeg.dash.mpd', () => new DashParser());
};
