import { asserts } from '../debug/asserts';
import { FakeEventTarget } from './fake_event_target';

/**
 * @summary Create an Event work-alike object based on the provided dictionary.
 * The event should contain all of the same properties from the dict.
 *
 * @extends {Event}
 * @export
 */
export class FakeEvent {
  static fromRealEvent(event: Event): FakeEvent {
    const fakeEvent = new FakeEvent(event.type);
    for (const key in event) {
      Object.defineProperty(fakeEvent, key, {
        // @ts-ignore
        value: event[key],
        writable: true,
        enumerable: true,
      });
    }
    return fakeEvent;
  }
  timestamp: number;
  bubbles = false;
  cancelable = false;
  defaultPrevented = false;
  type: string;
  currentTarget: FakeEventTarget | null = null;
  target: FakeEventTarget | null = null;
  stopped = false;
  constructor(type: string, dict?: Map<string, any> | Record<string, any>) {
    if (dict) {
      if (dict instanceof Map) {
        for (const key of dict.keys()) {
          Object.defineProperty(this, key, {
            value: dict.get(key),
            writable: true,
            configurable: true,
          });
        }
      } else {
        asserts.assert(!(dict instanceof Map), 'dict should not be a map');
        for (const key in dict) {
          Object.defineProperty(this, key, {
            value: dict[key],
            writable: true,
            enumerable: true,
          });
        }
      }
    }
    this.type = type;
    this.timestamp =
      window.performance && window.performance.now
        ? window.performance.now()
        : Date.now();
  }
  /**
   * Prevents the default action of the event.  Has no effect if the event isn't
   * cancellable.
   * @override
   */
  preventDefault() {
    if (this.cancelable) {
      this.defaultPrevented = true;
    }
  }

  /**
   * Stops processing event listeners for this event.  Provided for
   * compatibility with native Events.
   * @override
   */
  stopImmediatePropagation() {
    this.stopped = true;
  }

  /**
   * Does nothing, since FakeEvents do not bubble.  Provided for compatibility
   * with native Events.
   * @override
   */
  stopPropagation() {}
  static EventName = {
    AbrStatusChanged: 'abrstatuschanged',
    Adaptation: 'adaptation',
    Buffering: 'buffering',
    Complete: 'complete',
    DownloadFailed: 'downloadfailed',
    DownloadHeadersReceived: 'downloadheadersreceived',
    DrmSessionUpdate: 'drmsessionupdate',
    Emsg: 'emsg',
    Prft: 'prft',
    Error: 'error',
    ExpirationUpdated: 'expirationupdated',
    FirstQuartile: 'firstquartile',
    GapJumped: 'gapjumped',
    KeyStatusChanged: 'keystatuschanged',
    Loaded: 'loaded',
    Loading: 'loading',
    ManifestParsed: 'manifestparsed',
    ManifestUpdated: 'manifestupdated',
    MediaQualityChanged: 'mediaqualitychanged',
    Metadata: 'metadata',
    Midpoint: 'midpoint',
    NoSpatialVideoInfoEvent: 'nospatialvideoinfo',
    OnStateChange: 'onstatechange',
    RateChange: 'ratechange',
    SegmentAppended: 'segmentappended',
    SessionDataEvent: 'sessiondata',
    SpatialVideoInfoEvent: 'spatialvideoinfo',
    StallDetected: 'stalldetected',
    Started: 'started',
    StateChanged: 'statechanged',
    Streaming: 'streaming',
    TextChanged: 'textchanged',
    TextTrackVisibility: 'texttrackvisibility',
    ThirdQuartile: 'thirdquartile',
    TimelineRegionAdded: 'timelineregionadded',
    TimelineRegionEnter: 'timelineregionenter',
    TimelineRegionExit: 'timelineregionexit',
    TracksChanged: 'trackschanged',
    Unloading: 'unloading',
    VariantChanged: 'variantchanged',
  };
}
