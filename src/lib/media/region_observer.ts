/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { TimelineRegionInfo } from '../../externs/shaka';
import { EventManager } from '../util/event_manager';
import { FakeEvent } from '../util/fake_event';
import { FakeEventTarget } from '../util/fake_event_target';
import { IPlayheadObserver } from './playhead_observer';
import { RegionTimeline } from './region_timeline';

/**
 * The region observer watches a region timeline and playhead, and fires events
 * ('enter', 'exit', 'skip') as the playhead moves.
 *
 * @implements {shaka.media.IPlayheadObserver}
 * @final
 */
export class RegionObserver extends FakeEventTarget implements IPlayheadObserver {
  private timeline_: RegionTimeline;
  private startsPastZero_: boolean;

  private oldPosition_: Map<TimelineRegionInfo, RelativePosition>;
  private rules_: Rule[];
  private eventManager_: EventManager;
  /**
   * Create a region observer for the given timeline. The observer does not
   * own the timeline, only uses it. This means that the observer should NOT
   * destroy the timeline.
   *
   * @param timeline
   * @param  startsPastZero
   */
  constructor(timeline: RegionTimeline, startsPastZero: boolean) {
    super();

    this.timeline_ = timeline;

    /**
     * Whether the asset is expected to start at a time beyond 0 seconds.
     * For example, if the asset is a live stream.
     * If true, we will not start polling for regions until the playhead has
     * moved past 0 seconds, to avoid bad behaviors where the current time is
     * briefly 0 before we have enough data to play.
     */
    this.startsPastZero_ = startsPastZero;

    /**
     * A mapping between a region and where we previously were relative to it.
     * When the value here differs from what we calculate, it means we moved and
     * should fire an event.
     *
     * @private {!Map.<shaka.extern.TimelineRegionInfo,
     *                 shaka.media.RegionObserver.RelativePosition_>}
     */
    this.oldPosition_ = new Map();

    // To make the rules easier to read, alias all the relative positions.

    const BEFORE_THE_REGION = RelativePosition.BEFORE_THE_REGION;
    const IN_THE_REGION = RelativePosition.IN_THE_REGION;
    const AFTER_THE_REGION = RelativePosition.AFTER_THE_REGION;

    /**
     * A read-only collection of rules for what to do when we change position
     * relative to a region.
     *
     */
    this.rules_ = [
      {
        weWere: null,
        weAre: IN_THE_REGION,
        invoke: (region, seeking) => this.onEvent_('enter', region, seeking),
      },
      {
        weWere: BEFORE_THE_REGION,
        weAre: IN_THE_REGION,
        invoke: (region, seeking) => this.onEvent_('enter', region, seeking),
      },
      {
        weWere: AFTER_THE_REGION,
        weAre: IN_THE_REGION,
        invoke: (region, seeking) => this.onEvent_('enter', region, seeking),
      },
      {
        weWere: IN_THE_REGION,
        weAre: BEFORE_THE_REGION,
        invoke: (region, seeking) => this.onEvent_('exit', region, seeking),
      },
      {
        weWere: IN_THE_REGION,
        weAre: AFTER_THE_REGION,
        invoke: (region, seeking) => this.onEvent_('exit', region, seeking),
      },
      {
        weWere: BEFORE_THE_REGION,
        weAre: AFTER_THE_REGION,
        invoke: (region, seeking) => this.onEvent_('skip', region, seeking),
      },
      {
        weWere: AFTER_THE_REGION,
        weAre: BEFORE_THE_REGION,
        invoke: (region, seeking) => this.onEvent_('skip', region, seeking),
      },
    ];

    this.eventManager_ = new EventManager();

    this.eventManager_.listen(this.timeline_, 'regionremove', (event: any) => {
      const region = event['region'];
      this.oldPosition_.delete(region);
    });
  }

  /** @override */
  release() {
    this.timeline_ = null as any;

    // Clear our maps so that we are not holding onto any more information than
    // needed.
    this.oldPosition_.clear();

    this.eventManager_.release();
    this.eventManager_ = null as any;

    super.release();
  }

  poll(positionInSeconds: number, wasSeeking: boolean) {
    if (this.startsPastZero_ && positionInSeconds == 0) {
      // Don't start checking regions until the timeline has begun moving.
      return;
    }
    // Now that we have seen the playhead go past 0, it's okay if it goes
    // back there (e.g. seeking back to the start).
    this.startsPastZero_ = false;

    for (const region of this.timeline_.regions()) {
      const previousPosition = this.oldPosition_.get(region);
      const currentPosition = RegionObserver.determinePositionRelativeTo_(region, positionInSeconds);

      // We will only use |previousPosition| and |currentPosition|, so we can
      // update our state now.
      this.oldPosition_.set(region, currentPosition);

      for (const rule of this.rules_) {
        if (rule.weWere == previousPosition && rule.weAre == currentPosition) {
          rule.invoke(region, wasSeeking);
        }
      }
    }
  }

  /**
   * Dispatch events of the given type.  All event types in this class have the
   * same parameters: region and seeking.
   *
   * @param {string} eventType
   * @param {shaka.extern.TimelineRegionInfo} region
   * @param {boolean} seeking
   * @private
   */
  onEvent_(eventType: string, region: TimelineRegionInfo, seeking: boolean) {
    const event = new FakeEvent(
      eventType,
      // @ts-expect-error
      new Map([
        ['region', region],
        ['seeking', seeking],
      ])
    );
    this.dispatchEvent(event);
  }

  /**
   * Get the relative position of the playhead to |region| when the playhead is
   * at |seconds|. We treat the region's start and end times as inclusive
   * bounds.
   *
   * @param region
   * @param seconds
   * @return
   * @private
   */
  private static determinePositionRelativeTo_(region: TimelineRegionInfo, seconds: number) {
    if (seconds < region.startTime) {
      return RelativePosition.BEFORE_THE_REGION;
    }

    if (seconds > region.endTime) {
      return RelativePosition.AFTER_THE_REGION;
    }

    return RelativePosition.IN_THE_REGION;
  }
}

/**
 * An enum of relative positions between the playhead and a region. Each is
 * phrased so that it works in "The playhead is X" where "X" is any value in
 * the enum.
 *
 */
const enum RelativePosition {
  BEFORE_THE_REGION = 1,
  IN_THE_REGION = 2,
  AFTER_THE_REGION = 3,
}

/**
 * All region observer events (onEnter, onExit, and onSkip) will be passed the
 * region that the playhead is interacting with and whether or not the playhead
 * moving is part of a seek event.
 *
 */
export type RegionObserverEventListener = (regionInfo: TimelineRegionInfo, b: boolean) => void;

interface Rule {
  weWere: RelativePosition | null;
  weAre: RelativePosition;
  invoke: RegionObserverEventListener;
}
