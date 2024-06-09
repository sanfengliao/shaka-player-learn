import { TimelineRegionInfo } from '../../externs/shaka';
import { FakeEvent } from '../util/fake_event';
import { FakeEventTarget } from '../util/fake_event_target';
import { IReleasable } from '../util/i_releasable';
import { Timer } from '../util/timer';

export class RegionTimeline extends FakeEventTarget implements IReleasable {
  private regions_ = new Set<TimelineRegionInfo>();
  private getSeekRange_: () => {
    start: number;
    end: number;
  };

  static REGION_FILTER_INTERVAL = 2;

  filterTimer_ = new Timer(() => {
    this.filterBySeekRange_();
  }).tickEvery(/* seconds= */ RegionTimeline.REGION_FILTER_INTERVAL);
  constructor(
    getSeekRange: () => {
      start: number;
      end: number;
    }
  ) {
    super();
    this.getSeekRange_ = getSeekRange;
  }

  release() {
    this.regions_.clear();
    this.filterTimer_.stop();
    super.release();
  }

  addRegion(region: TimelineRegionInfo) {
    const similarRegion = this.findSimilarRegion_(region);

    // Make sure we don't add duplicate regions. We keep track of this here
    // instead of making the parser track it.
    if (similarRegion == null) {
      this.regions_.add(region);
      const event = new FakeEvent('regionadd', new Map([['region', region]]));
      this.dispatchEvent(event);
    }
  }

  filterBySeekRange_() {
    const seekRange = this.getSeekRange_();
    for (const region of this.regions_) {
      // Only consider the seek range start here.
      // Future regions might become relevant eventually,
      // but regions that are in the past and can't ever be
      // seeked to will never come up again, and there's no
      // reson to store or process them.
      if (region.endTime < seekRange.start) {
        this.regions_.delete(region);
        const event = new FakeEvent('regionremove', new Map([['region', region]]));
        this.dispatchEvent(event);
      }
    }
  }

  /**
   * Find a region in the timeline that has the same scheme id uri, event id,
   * start time and end time. If these four parameters match, we assume it
   * to be the same region. If no similar region can be found, |null| will be
   * returned.
   *
   * @param region
   * @return
   * @private
   */
  findSimilarRegion_(region: TimelineRegionInfo) {
    for (const existing of this.regions_) {
      // The same scheme ID and time range means that it is similar-enough to
      // be the same region.
      const isSimilar =
        existing.schemeIdUri == region.schemeIdUri &&
        existing.id == region.id &&
        existing.startTime == region.startTime &&
        existing.endTime == region.endTime;

      if (isSimilar) {
        return existing;
      }
    }

    return null;
  }

  /**
   * Get an iterable for all the regions in the timeline. This will allow
   * others to see what regions are in the timeline while not being able to
   * change the collection.
   *
   * @return
   */
  regions() {
    return this.regions_;
  }
}
