import { asserts } from '../debug/asserts';
import { log } from '../debug/log';
import { SegmentReference } from './segment_reference';

export class PresentationTimeline {
  private presentationStartTime_: number;
  private presentationDelay_: number;
  private autoCorrectDrift_: boolean;
  private duration_ = Infinity;
  private segmentAvailabilityDuration_ = Infinity;
  /**
   * The maximum segment duration (in seconds).  Can be based on explicitly-
   * known segments or on signalling in the manifest.
   *
   */
  private maxSegmentDuration_ = -1;

  /**
   * The minimum segment start time (in seconds, in the presentation timeline)
   * for segments we explicitly know about.
   *
   * This is null if we have no explicit descriptions of segments, such as in
   * DASH when using SegmentTemplate w/ duration.
   *
   */
  private minSegmentStartTime_: number | null = null;

  /**
   * The maximum segment end time (in seconds, in the presentation timeline)
   * for segments we explicitly know about.
   *
   * This is null if we have no explicit descriptions of segments, such as in
   * DASH when using SegmentTemplate w/ duration.  When this is non-null, the
   * presentation start time is calculated from the segment end times.
   *
   */
  private maxSegmentEndTime_: number | null = null;

  private clockOffset_ = 0;

  private static_ = true;

  private userSeekStart_ = 0;
  /**
   * For low latency Dash, availabilityTimeOffset indicates a segment is
   * available for download earlier than its availability start time.
   * This field is the minimum availabilityTimeOffset value among the
   * segments. We reduce the distance from live edge by this value.
   * 对于低延迟的Dash，availabilityTimeOffset表示一个片段可以早于其可用起始
   * 时间进行下载。这个字段是所有片段中最小的availabilityTimeOffset值。
   * 我们通过这个值减少与直播边缘的距离。
   */
  private availabilityTimeOffset_ = 0;

  private startTimeLocked_ = false;

  private initialProgramDateTime_: number | null = null;

  /**
   * @param presentationStartTime The wall-clock time, in seconds,
   *   when the presentation started or will start. Only required for live.
   * @param  presentationDelay The delay to give the presentation, in
   *   seconds.  Only required for live.
   * @param autoCorrectDrift Whether to account for drift when
   *   determining the availability window.
   */
  constructor(presentationStartTime: number, presentationDelay: number, autoCorrectDrift = false) {
    this.presentationStartTime_ = presentationStartTime;
    this.presentationDelay_ = presentationDelay;
    this.autoCorrectDrift_ = autoCorrectDrift;
  }

  /**
   * @return The presentation's duration in seconds.
   *   Infinity indicates that the presentation continues indefinitely.
   * @export
   */
  getDuration() {
    return this.duration_;
  }

  /**
   * @return The presentation's max segment duration in seconds.
   * @export
   */
  getMaxSegmentDuration() {
    return this.maxSegmentDuration_;
  }

  /**
   * Sets the presentation's start time.
   *
   * @param {number} presentationStartTime The wall-clock time, in seconds,
   *   when the presentation started or will start. Only required for live.
   * @export
   */
  setPresentationStartTime(presentationStartTime: number) {
    asserts.assert(presentationStartTime >= 0, 'presentationStartTime must be >= 0');
    this.presentationStartTime_ = presentationStartTime;
  }

  /**
   * Sets the presentation's duration.
   *
   * @param duration The presentation's duration in seconds.
   *   Infinity indicates that the presentation continues indefinitely.
   * @export
   */
  setDuration(duration: number) {
    asserts.assert(duration > 0, 'duration must be > 0');
    this.duration_ = duration;
  }

  /**
   * @return The presentation's start time in seconds.
   * @export
   */
  getPresentationStartTime() {
    return this.presentationStartTime_;
  }

  /**
   * Sets the clock offset, which is the difference between the client's clock
   * and the server's clock, in milliseconds (i.e., serverTime = Date.now() +
   * clockOffset).
   *
   * @param offset The clock offset, in ms.
   * @export
   */
  setClockOffset(offset: number) {
    this.clockOffset_ = offset;
  }

  /**
   * Sets the presentation's static flag.
   *
   * @param {boolean} isStatic If true, the presentation is static, meaning all
   *   segments are available at once.
   * @export
   */
  setStatic(isStatic: boolean) {
    // NOTE: the argument name is not "static" because that's a keyword in ES6
    this.static_ = isStatic;
  }

  /**
   * Sets the presentation's segment availability duration. The segment
   * availability duration should only be set for live.
   *
   * @param segmentAvailabilityDuration The presentation's new segment
   *   availability duration in seconds.
   * @export
   */
  setSegmentAvailabilityDuration(segmentAvailabilityDuration: number) {
    asserts.assert(segmentAvailabilityDuration >= 0, 'segmentAvailabilityDuration must be >= 0');
    this.segmentAvailabilityDuration_ = segmentAvailabilityDuration;
  }

  /**
   * Gets the presentation's segment availability duration.
   *
   * @export
   */
  getSegmentAvailabilityDuration() {
    return this.segmentAvailabilityDuration_;
  }

  /**
   * Sets the presentation delay in seconds.
   *
   * @param {number} delay
   * @export
   */
  setDelay(delay: number) {
    // NOTE: This is no longer used internally, but is exported.
    // So we cannot remove it without deprecating it and waiting one release
    // cycle, or else we risk breaking custom manifest parsers.
    asserts.assert(delay >= 0, 'delay must be >= 0');
    this.presentationDelay_ = delay;
  }

  /**
   * Gets the presentation delay in seconds.
   * @return {number}
   * @export
   */
  getDelay() {
    return this.presentationDelay_;
  }

  /**
   * Gives PresentationTimeline a Stream's timeline so it can size and position
   * the segment availability window, and account for missing segment
   * information.
   *
   * @param timeline
   * @param startOffset
   * @export
   */

  notifyTimeRange(timeline: TimeRange[], startOffset: number) {
    if (timeline.length === 0) {
      return;
    }

    const firstStartTime = timeline[0].start + startOffset;
    const lastEndTime = timeline[timeline.length - 1].end + startOffset;

    this.notifyMinSegmentStartTime(firstStartTime);

    this.maxSegmentDuration_ = timeline.reduce((max, r) => {
      return Math.max(max, r.end - r.start);
    }, this.maxSegmentDuration_);

    this.maxSegmentEndTime_ = Math.max(this.maxSegmentEndTime_ || 0, lastEndTime);

    if (this.presentationStartTime_ != null && this.autoCorrectDrift_ && !this.startTimeLocked_) {
      // Since we have explicit segment end times, calculate a presentation
      // start based on them.  This start time accounts for drift.
      // Date.now() is in milliseconds, from which we compute "now" in seconds.
      const now = (Date.now() + this.clockOffset_) / 1000;
      this.presentationStartTime_ = now - this.maxSegmentEndTime_ - this.maxSegmentDuration_;
    }
    log.v1('notifySegments:', 'maxSegmentDuration=' + this.maxSegmentDuration_);
  }

  /**
   * Gives PresentationTimeline an array of segments so it can size and position
   * the segment availability window, and account for missing segment
   * information.  These segments do not necessarily need to all be from the
   * same stream.
   *
   * @param  references
   * @export
   */

  notifySegments(references: SegmentReference[]) {
    if (references.length === 0) {
      return;
    }

    let firstReferenceStartTime = references[0].startTime;
    let lastReferenceEndTime = references[0].endTime;

    // Date.now() is in milliseconds, from which we compute "now" in seconds.
    const now = (Date.now() + this.clockOffset_) / 1000.0;
    for (const reference of references) {
      if (now < reference.startTime) {
        return;
      }

      firstReferenceStartTime = Math.min(firstReferenceStartTime, reference.startTime);

      lastReferenceEndTime = Math.max(lastReferenceEndTime, reference.endTime);

      this.maxSegmentDuration_ = Math.max(this.maxSegmentDuration_, reference.endTime - reference.startTime);
    }
    this.notifyMinSegmentStartTime(firstReferenceStartTime);

    this.maxSegmentEndTime_ = Math.max(this.maxSegmentEndTime_ || 0, lastReferenceEndTime);

    if (this.presentationStartTime_ != null && this.autoCorrectDrift_ && !this.startTimeLocked_) {
      // Since we have explicit segment end times, calculate a presentation
      // start based on them.  This start time accounts for drift.
      this.presentationStartTime_ = now - this.maxSegmentEndTime_ - this.maxSegmentDuration_;
    }
    log.v1('notifySegments:', 'maxSegmentDuration=' + this.maxSegmentDuration_);
  }

  /**
   * Gives PresentationTimeline a Stream's minimum segment start time.
   *
   * @param {number} startTime
   * @export
   */
  notifyMinSegmentStartTime(startTime: number) {
    if (this.minSegmentStartTime_ == null) {
      // No data yet, and Math.min(null, startTime) is always 0.  So just store
      // startTime.
      this.minSegmentStartTime_ = startTime;
    } else {
      this.minSegmentStartTime_ = Math.min(this.minSegmentStartTime_, startTime);
    }
  }

  /**
   * Lock the presentation timeline's start time.  After this is called, no
   * further adjustments to presentationStartTime_ will be permitted.
   *
   * This should be called after all Periods have been parsed, and all calls to
   * notifySegments() from the initial manifest parse have been made.
   *
   * Without this, we can get assertion failures in SegmentIndex for certain
   * DAI content.  If DAI adds ad segments to the manifest faster than
   * real-time, adjustments to presentationStartTime_ can cause availability
   * windows to jump around on updates.
   *
   * @export
   */
  lockStartTime() {
    this.startTimeLocked_ = true;
  }

  /**
   * Returns if the presentation timeline's start time is locked.
   *
   * @return {boolean}
   * @export
   */
  isStartTimeLocked() {
    return this.startTimeLocked_;
  }

  /**
   * Sets the initial program date time.
   *
   * @param {number} initialProgramDateTime
   * @export
   */
  setInitialProgramDateTime(initialProgramDateTime: number) {
    this.initialProgramDateTime_ = initialProgramDateTime;
  }
  /**
   * @return {?number} The initial program date time in seconds.
   * @export
   */
  getInitialProgramDateTime() {
    return this.initialProgramDateTime_;
  }

  /**
   * Gives PresentationTimeline a Stream's maximum segment duration so it can
   * size and position the segment availability window.  This function should be
   * called once for each Stream (no more, no less), but does not have to be
   * called if notifySegments() is called instead for a particular stream.
   *
   * @param {number} maxSegmentDuration The maximum segment duration for a
   *   particular stream.
   * @export
   */
  notifyMaxSegmentDuration(maxSegmentDuration: number) {
    this.maxSegmentDuration_ = Math.max(this.maxSegmentDuration_, maxSegmentDuration);

    log.v1('notifyNewSegmentDuration:', 'maxSegmentDuration=' + this.maxSegmentDuration_);
  }

  /**
   * Offsets the segment times by the given amount.
   *
   * @param {number} offset The number of seconds to offset by.  A positive
   *   number adjusts the segment times forward.
   * @export
   */
  offset(offset: number) {
    if (this.minSegmentStartTime_ != null) {
      this.minSegmentStartTime_ += offset;
    }

    if (this.maxSegmentEndTime_ != null) {
      this.maxSegmentEndTime_ += offset;
    }
  }

  /**
   * @return {boolean} True if the presentation is live; otherwise, return
   *   false.
   * @export
   */
  isLive() {
    return this.duration_ == Infinity && !this.static_;
  }

  /**
   * @return {boolean} True if the presentation is in progress (meaning not
   *   live, but also not completely available); otherwise, return false.
   * @export
   */
  isInProgress() {
    return this.duration_ != Infinity && !this.static_;
  }

  /**
   * Gets the presentation's current segment availability start time.  Segments
   * ending at or before this time should be assumed to be unavailable.
   *
   * @return {number} The current segment availability start time, in seconds,
   *   relative to the start of the presentation.
   * @export
   */

  getSegmentAvailabilityStart() {
    asserts.assert(this.segmentAvailabilityDuration_ >= 0, 'The availability duration should be positive');
    const end = this.getSegmentAvailabilityEnd();
    const start = end - this.segmentAvailabilityDuration_;
    return Math.max(this.userSeekStart_, start);
  }

  /**
   * Gets the presentation's current segment availability end time.  Segments
   * starting after this time should be assumed to be unavailable.
   *
   * @return {number} The current segment availability end time, in seconds,
   *   relative to the start of the presentation.  For VOD, the availability
   *   end time is the content's duration.  If the Player's playRangeEnd
   *   configuration is used, this can override the duration.
   * @export
   */

  getSegmentAvailabilityEnd() {
    if (!this.isLive() && !this.isInProgress()) {
      if (this.maxSegmentEndTime_) {
        return Math.min(this.maxSegmentEndTime_, this.duration_);
      } else {
        return this.duration_;
      }
    }
    return Math.min(this.getLiveEdge_() + this.availabilityTimeOffset_, this.duration_);
  }

  /**
   * @return {number} The current presentation time in seconds.
   * @private
   */
  getLiveEdge_() {
    asserts.assert(this.presentationStartTime_ !== null, 'Cannot compute timeline live edge without start time');
    const now = (Date.now() + this.clockOffset_) / 1000.0;
    return Math.max(0, now - this.maxSegmentDuration_ - this.presentationStartTime_);
  }

  /**
   * Sets the start time of the user-defined seek range.  This is only used for
   * VOD content.
   *
   * @param {number} time
   * @export
   */
  setUserSeekStart(time: number) {
    this.userSeekStart_ = time;
  }

  /**
   * Gets the seek range start time, offset by the given amount.  This is used
   * to ensure that we don't "fall" back out of the seek window while we are
   * buffering.
   *
   * @param {number} offset The offset to add to the start time for live
   *   streams.
   * @return {number} The current seek start time, in seconds, relative to the
   *   start of the presentation.
   * @export
   */
  getSafeSeekRangeStart(offset: number) {
    // The earliest known segment time, ignoring segment availability duration.
    const earliestSegmentTime = Math.max(this.minSegmentStartTime_ || 0, this.userSeekStart_);

    // For VOD, the offset and end time are ignored, and we just return the
    // earliest segment time.  All segments are "safe" in VOD.  However, we
    // should round up to the nearest millisecond to avoid issues like
    // https://github.com/shaka-project/shaka-player/issues/2831, in which we
    // tried to seek repeatedly to catch up to the seek range, and never
    // actually "arrived" within it.  The video's currentTime is not as
    // accurate as the JS number representing the earliest segment time for
    // some content.

    if (this.segmentAvailabilityDuration_ === Infinity) {
      return Math.ceil(earliestSegmentTime * 1e3) / 1e3;
    }

    // AKA the live edge for live streams.
    const availabilityEnd = this.getSegmentAvailabilityEnd();

    // The ideal availability start, not considering known segments.
    const availabilityStart = availabilityEnd - this.segmentAvailabilityDuration_;

    // Add the offset to the availability start to ensure that we don't fall
    // outside the availability window while we buffer; we don't need to add the
    // offset to earliestSegmentTime since that won't change over time.
    // Also see: https://github.com/shaka-project/shaka-player/issues/692
    const desiredStart = Math.min(availabilityStart + offset, this.getSeekRangeEnd());
    return Math.max(earliestSegmentTime, desiredStart);
  }

  /**
   * Gets the seek range start time.
   *
   * @return {number}
   * @export
   */
  getSeekRangeStart() {
    return this.getSafeSeekRangeStart(/* offset= */ 0);
  }

  /**
   * Gets the seek range end.
   *
   * @return {number}
   * @export
   */
  getSeekRangeEnd() {
    const useDelay = this.isLive() || this.isInProgress();
    const delay = useDelay ? this.presentationDelay_ : 0;
    return Math.max(0, this.getSegmentAvailabilityEnd() - delay);
  }

  /**
   * True if the presentation start time is being used to calculate the live
   * edge.
   * Using the presentation start time means that the stream may be subject to
   * encoder drift.  At runtime, we will avoid using the presentation start time
   * whenever possible.
   *
   * @return {boolean}
   * @export
   */

  usingPresentationStartTime() {
    // If it's VOD, IPR, or an HLS "event", we are not using the presentation
    // start time.
    if (this.presentationStartTime_ == null) {
      return false;
    }

    // If we have explicit segment times, we're not using the presentation
    // start time.
    if (this.maxSegmentEndTime_ != null && this.autoCorrectDrift_) {
      return false;
    }

    return true;
  }

  /**
   * Sets the presentation's segment availability time offset. This should be
   * only set for Low Latency Dash.
   * The segments are available earlier for download than the availability start
   * time, so we can move closer to the live edge.
   *
   * @param {number} offset
   * @export
   */
  setAvailabilityTimeOffset(offset: number) {
    this.availabilityTimeOffset_ = offset;
  }

  /**
   * Debug only: assert that the timeline parameters make sense for the type
   * of presentation (VOD, IPR, live).
   */
  assertIsValid() {
    if (__DEV__) {
      if (this.isLive()) {
        // Implied by isLive(): infinite and dynamic.
        // Live streams should have a start time.
        asserts.assert(
          this.presentationStartTime_ != null,
          'Detected as live stream, but does not match our model of live!'
        );
      } else if (this.isInProgress()) {
        // Implied by isInProgress(): finite and dynamic.
        // IPR streams should have a start time, and segments should not expire.
        asserts.assert(
          this.presentationStartTime_ != null && this.segmentAvailabilityDuration_ == Infinity,
          'Detected as IPR stream, but does not match our model of IPR!'
        );
      } else {
        // VOD
        // VOD segments should not expire and the presentation should be finite
        // and static.
        asserts.assert(
          this.segmentAvailabilityDuration_ == Infinity && this.duration_ != Infinity && this.static_,
          'Detected as VOD stream, but does not match our model of VOD!'
        );
      }
    }
  }
}

/**
 * @description
 * Defines a time range of a media segment.  Times are in seconds.
 */
export interface TimeRange {
  // The start time of the range.
  start: number;
  // The start time of the range in representation timescale units.
  unscaledStart: number;
  // The end time (exclusive) of the range.
  end: number;
  // The number of partial segments
  partialSegments: number;
  // The segment position of the timeline entry as it appears in the manifest
  segmentPosition: number;
}
