/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { FakeEvent } from '../util/fake_event';
import { IReleasable } from '../util/i_releasable';
import { TimeRangesUtils } from './time_range_utils';

/**
 * Some platforms/browsers can get stuck in the middle of a buffered range (e.g.
 * when seeking in a background tab). Detect when we get stuck so that the
 * player can respond.
 *
 */
export class StallDetector implements IReleasable {
  private onEvent_: (e: FakeEvent) => void;
  private implementation_: StallDetectorImplementation;
  private wasMakingProgress_: boolean;
  private value_: number;
  private lastUpdateSeconds_: number;
  private didJump_: boolean;
  private stallsDetected_: number;
  /**
   * The amount of time in seconds that we must have the same value of
   * |value_| before we declare it as a stall.
   */
  private stallThresholdSeconds_: number;
  private onStall_: (a: number, b: number) => void;
  /**
   * @param implementation
   * @param stallThresholdSeconds
   * @param onEvent
   *     Called when an event is raised to be sent to the application.
   */
  constructor(
    implementation: StallDetectorImplementation,
    stallThresholdSeconds: number,
    onEvent: (e: FakeEvent) => void
  ) {
    this.onEvent_ = onEvent;

    this.implementation_ = implementation;

    this.wasMakingProgress_ = implementation.shouldBeMakingProgress();

    this.value_ = implementation.getPresentationSeconds();

    this.lastUpdateSeconds_ = implementation.getWallSeconds();

    this.didJump_ = false;

    this.stallsDetected_ = 0;

    /**
     * The amount of time in seconds that we must have the same value of
     * |value_| before we declare it as a stall.
     *
     */
    this.stallThresholdSeconds_ = stallThresholdSeconds;

    this.onStall_ = () => {};
  }

  release() {
    // Drop external references to make things easier on the GC.
    this.implementation_ = null as any;
    this.onEvent_ = null as any;
    this.onStall_ = () => {};
  }

  /**
   * Set the callback that should be called when a stall is detected. Calling
   * this will override any previous calls to |onStall|.
   *
   * @param {function(number, number)} doThis
   */
  onStall(doThis: (a: number, b: number) => void) {
    this.onStall_ = doThis;
  }

  /**
   * Returns the number of playback stalls detected.
   */
  getStallsDetected() {
    return this.stallsDetected_;
  }

  /**
   * Have the detector update itself and fire the "on stall" callback if a stall
   * was detected.
   *
   * @return True if action was taken.
   */
  poll() {
    const impl = this.implementation_;

    const shouldBeMakingProgress = impl.shouldBeMakingProgress();
    const value = impl.getPresentationSeconds();
    const wallTimeSeconds = impl.getWallSeconds();

    const acceptUpdate = this.value_ !== value || this.wasMakingProgress_ !== shouldBeMakingProgress;

    if (acceptUpdate) {
      this.lastUpdateSeconds_ = wallTimeSeconds;
      this.value_ = value;
      this.wasMakingProgress_ = shouldBeMakingProgress;
      this.didJump_ = false;
    }

    const stallSeconds = wallTimeSeconds - this.lastUpdateSeconds_;

    const triggerCallback = stallSeconds >= this.stallThresholdSeconds_ && shouldBeMakingProgress && !this.didJump_;

    if (triggerCallback) {
      this.onStall_(this.value_, stallSeconds);
      this.didJump_ = true;
      // If the onStall_ method updated the current time, update our stored
      // value so we don't think that was an update.
      this.value_ = impl.getPresentationSeconds();
      this.stallsDetected_++;
      this.onEvent_(new FakeEvent(FakeEvent.EventName.StallDetected));
    }

    return triggerCallback;
  }
}

export interface StallDetectorImplementation {
  /**
   * Check if the presentation time should be changing. This will return |true|
   * when we expect the presentation time to change.
   *
   */
  shouldBeMakingProgress: () => boolean;

  /**
   * Get the presentation time in seconds.
   *
   */
  getPresentationSeconds: () => number;

  /**
   * Get the time wall time in seconds.
   *
   * @return {number}
   */
  getWallSeconds: () => number;
}

/**
 * Some platforms/browsers can get stuck in the middle of a buffered range (e.g.
 * when seeking in a background tab). Force a seek to help get it going again.
 *
 */
export class MediaElementImplementation implements StallDetectorImplementation {
  private mediaElement_: HTMLMediaElement;

  constructor(mediaElement: HTMLMediaElement) {
    this.mediaElement_ = mediaElement;
  }

  shouldBeMakingProgress() {
    // If we are not trying to play, the lack of change could be misidentified
    // as a stall.
    if (this.mediaElement_.paused) {
      return false;
    }
    if (this.mediaElement_.playbackRate == 0) {
      return false;
    }

    // If we have don't have enough content, we are not stalled, we are
    // buffering.
    if (this.mediaElement_.buffered.length == 0) {
      return false;
    }

    return MediaElementImplementation.hasContentFor_(this.mediaElement_.buffered, this.mediaElement_.currentTime);
  }

  getPresentationSeconds() {
    return this.mediaElement_.currentTime;
  }

  getWallSeconds() {
    return Date.now() / 1000;
  }

  /**
   * Check if we have buffered enough content to play at |timeInSeconds|. Ignore
   * the end of the buffered range since it may not play any more on all
   * platforms.
   *
   * @param buffered
   * @param timeInSeconds
   * @retur
   * @private
   */
  static hasContentFor_(buffered: TimeRanges, timeInSeconds: number) {
    for (const { start, end } of TimeRangesUtils.getBufferedInfo(buffered)) {
      // Can be as much as 100ms before the range
      if (timeInSeconds < start - 0.1) {
        continue;
      }
      // Must be at least 500ms inside the range
      if (timeInSeconds > end - 0.5) {
        continue;
      }

      return true;
    }

    return false;
  }
}
