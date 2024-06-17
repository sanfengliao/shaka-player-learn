/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { StatsInfo } from '../../externs/shaka';
import { SwitchHistory } from '../util/switch_history';
import { StateHistory } from './state_history';

/**
 * This class tracks all the various components (some optional) that are used to
 * populate |shaka.extern.Stats| which is passed to the app.
 *
 * @final
 */
export class Stats {
  private width_: number = NaN;
  private height_: number = NaN;
  private totalDroppedFrames_: number = NaN;
  private totalDecodedFrames_: number = NaN;
  private totalCorruptedFrames_: number = NaN;
  private totalStallsDetected_: number = NaN;
  private totalGapsJumped_: number = NaN;
  private completionPercent_: number = NaN;
  private loadLatencySeconds_: number = NaN;
  private manifestTimeSeconds_: number = NaN;
  private drmTimeSeconds_: number = NaN;
  private licenseTimeSeconds_: number = NaN;
  private liveLatencySeconds_: number = NaN;
  private maxSegmentDurationSeconds_: number = NaN;
  private currentStreamBandwidth_: number = NaN;
  private bandwidthEstimate_: number = NaN;
  private bytesDownloaded_: number = NaN;
  private stateHistory_: StateHistory = new StateHistory();
  private switchHistory_: SwitchHistory = new SwitchHistory();
  private manifestSizeBytes_: number = NaN;

  /**
   * Update the ratio of dropped frames to total frames. This will replace the
   * previous values.
   *
   * @param {number} dropped
   * @param {number} decoded
   */
  setDroppedFrames(dropped: number, decoded: number) {
    this.totalDroppedFrames_ = dropped;
    this.totalDecodedFrames_ = decoded;
  }

  /**
   * Update corrupted frames. This will replace the previous values.
   *
   * @param {number} corrupted
   */
  setCorruptedFrames(corrupted: number) {
    this.totalCorruptedFrames_ = corrupted;
  }

  /**
   * Update number of stalls detected. This will replace the previous value.
   *
   * @param {number} stallsDetected
   */
  setStallsDetected(stallsDetected: number) {
    this.totalStallsDetected_ = stallsDetected;
  }

  /**
   * Update number of playback gaps jumped over. This will replace the previous
   * value.
   *
   * @param {number} gapsJumped
   */
  setGapsJumped(gapsJumped: number) {
    this.totalGapsJumped_ = gapsJumped;
  }

  /**
   * Set the width and height of the video we are currently playing.
   *
   * @param {number} width
   * @param {number} height
   */
  setResolution(width: number, height: number) {
    this.width_ = width;
    this.height_ = height;
  }

  /**
   * Record the time it took between the user signalling "I want to play this"
   * to "I am now seeing this".
   *
   * @param {number} seconds
   */
  setLoadLatency(seconds: number) {
    this.loadLatencySeconds_ = seconds;
  }

  /**
   * Record the time it took to download and parse the manifest.
   *
   * @param {number} seconds
   */
  setManifestTime(seconds: number) {
    this.manifestTimeSeconds_ = seconds;
  }

  /**
   * Record the current completion percent. This is the "high water mark", so it
   * will store the highest provided completion percent.
   *
   * @param {number} percent
   */
  setCompletionPercent(percent: number) {
    if (isNaN(this.completionPercent_)) {
      this.completionPercent_ = percent;
    } else {
      this.completionPercent_ = Math.max(this.completionPercent_, percent);
    }
  }

  /**
   * Record the time it took to download the first drm key.
   *
   * @param {number} seconds
   */
  setDrmTime(seconds: number) {
    this.drmTimeSeconds_ = seconds;
  }

  /**
   * Record the cumulative time spent on license requests during this session.
   *
   * @param {number} seconds
   */
  setLicenseTime(seconds: number) {
    this.licenseTimeSeconds_ = seconds;
  }

  /**
   * Record the latency in live streams.
   *
   * @param {number} seconds
   */
  setLiveLatency(seconds: number) {
    this.liveLatencySeconds_ = seconds;
  }

  /**
   * Record the presentation's max segment duration.
   *
   * @param {number} seconds
   */
  setMaxSegmentDuration(seconds: number) {
    this.maxSegmentDurationSeconds_ = seconds;
  }

  /**
   * @param {number} bandwidth
   */
  setCurrentStreamBandwidth(bandwidth: number) {
    this.currentStreamBandwidth_ = bandwidth;
  }

  /**
   * @param {number} bandwidth
   */
  setBandwidthEstimate(bandwidth: number) {
    this.bandwidthEstimate_ = bandwidth;
  }

  /**
   * @param {number} bytesDownloaded
   */
  addBytesDownloaded(bytesDownloaded: number) {
    if (isNaN(this.bytesDownloaded_)) {
      this.bytesDownloaded_ = bytesDownloaded;
    } else {
      this.bytesDownloaded_ += bytesDownloaded;
    }
  }

  getStateHistory() {
    return this.stateHistory_;
  }

  getSwitchHistory() {
    return this.switchHistory_;
  }

  setManifestSize(size: number) {
    this.manifestSizeBytes_ = size;
  }

  /**
   * Create a stats blob that we can pass up to the app. This blob will not
   * reference any internal data.
   *
   * @return {shaka.extern.Stats}
   */
  getBlob(): StatsInfo {
    return {
      width: this.width_,
      height: this.height_,
      streamBandwidth: this.currentStreamBandwidth_,
      decodedFrames: this.totalDecodedFrames_,
      droppedFrames: this.totalDroppedFrames_,
      corruptedFrames: this.totalCorruptedFrames_,
      stallsDetected: this.totalStallsDetected_,
      gapsJumped: this.totalGapsJumped_,
      estimatedBandwidth: this.bandwidthEstimate_,
      completionPercent: this.completionPercent_,
      loadLatency: this.loadLatencySeconds_,
      manifestTimeSeconds: this.manifestTimeSeconds_,
      drmTimeSeconds: this.drmTimeSeconds_,
      playTime: this.stateHistory_.getTimeSpentIn('playing'),
      pauseTime: this.stateHistory_.getTimeSpentIn('paused'),
      bufferingTime: this.stateHistory_.getTimeSpentIn('buffering'),
      licenseTime: this.licenseTimeSeconds_,
      liveLatency: this.liveLatencySeconds_,
      maxSegmentDuration: this.maxSegmentDurationSeconds_,
      bytesDownloaded: this.bytesDownloaded_,
      stateHistory: this.stateHistory_.getCopy(),
      switchHistory: this.switchHistory_.getCopy(),
      manifestSizeBytes: this.manifestSizeBytes_,
    };
  }

  /**
   * Create an empty stats blob. This resembles the stats when we are not
   * playing any content.
   *
   */
  static getEmptyBlob(): StatsInfo {
    return {
      width: NaN,
      height: NaN,
      streamBandwidth: NaN,
      decodedFrames: NaN,
      droppedFrames: NaN,
      corruptedFrames: NaN,
      stallsDetected: NaN,
      gapsJumped: NaN,
      estimatedBandwidth: NaN,
      completionPercent: NaN,
      loadLatency: NaN,
      manifestTimeSeconds: NaN,
      drmTimeSeconds: NaN,
      playTime: NaN,
      pauseTime: NaN,
      bufferingTime: NaN,
      licenseTime: NaN,
      liveLatency: NaN,
      maxSegmentDuration: NaN,
      bytesDownloaded: NaN,
      switchHistory: [],
      stateHistory: [],
      manifestSizeBytes: NaN,
    };
  }
}
