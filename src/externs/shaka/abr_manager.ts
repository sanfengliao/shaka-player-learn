/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CmsdManager } from '../../lib/util/cmsd_manager';
import { Variant } from './manifest';
import { Request } from './net';
import { AbrConfiguration } from './player';

/**
 * An object which selects Streams from a set of possible choices.  This also
 * watches for system changes to automatically adapt for the current streaming
 * requirements.  For example, when the network slows down, this class is in
 * charge of telling the Player which streams to switch to in order to reduce
 * the required bandwidth.
 *
 * This class is given a set of streams to choose from when the Player starts
 * up.  This class should store these and use them to make future decisions
 * about ABR.  It is up to this class how those decisions are made.  All the
 * Player will do is tell this class what streams to choose from.
 *
 * @interface
 * @exportDoc
 */
export interface AbrManager {
  /**
   * Initializes the AbrManager.
   */
  init(switchCallback: SwitchCallback): void;

  /**
   * Stops any background timers and frees any objects held by this instance.
   * This will only be called after a call to init.
   *
   * @exportDoc
   */
  stop(): void;

  /**
   * Request that this object release all internal references.
   * @exportDoc
   */
  release(): void;

  /**
   * Updates manager's variants collection.
   *
   * @param {!Array.<!shaka.extern.Variant>} variants
   * @exportDoc
   */
  setVariants(variants: Array<Variant>): void;

  /**
   * Chooses one variant to switch to.  Called by the Player.
   * @param {boolean=} preferFastSwitching If not provided meant "avoid fast
   *                                       switching if possible".
   * @return {shaka.extern.Variant}
   * @exportDoc
   */
  chooseVariant(preferFastSwitching: boolean): Variant;

  /**
   * Enables automatic Variant choices from the last ones passed to setVariants.
   * After this, the AbrManager may call switchCallback() at any time.
   *
   * @exportDoc
   */
  enable(): void;

  /**
   * Disables automatic Stream suggestions. After this, the AbrManager may not
   * call switchCallback().
   *
   * @exportDoc
   */
  disable(): void;

  /**
   * Notifies the AbrManager that a segment has been downloaded (includes MP4
   * SIDX data, WebM Cues data, initialization segments, and media segments).
   *
   * @param {number} deltaTimeMs The duration, in milliseconds, that the request
   *     took to complete.
   * @param {number} numBytes The total number of bytes transferred.
   * @param {boolean} allowSwitch Indicate if the segment is allowed to switch
   *     to another stream.
   * @param {shaka.extern.Request=} request
   *     A reference to the request
   * @exportDoc
   */
  segmentDownloaded(deltaTimeMs: number, numBytes: number, allowSwitch: boolean, request: Request | null): void;

  /**
   * Notifies the ABR that it is a time to suggest new streams. This is used by
   * the Player when it finishes adding the last partial segment of a fast
   * switching stream.
   *
   * @exportDoc
   */
  trySuggestStreams(): void;

  /**
   * Gets an estimate of the current bandwidth in bit/sec.  This is used by the
   * Player to generate stats.
   *
   * @return {number}
   * @exportDoc
   */
  getBandwidthEstimate(): number;

  /**
   * Updates manager playback rate.
   *
   * @param {number} rate
   * @exportDoc
   */
  playbackRateChanged(rate: number): void;

  /**
   * Set media element.
   *
   * @param {HTMLMediaElement} mediaElement
   * @exportDoc
   */
  setMediaElement(mediaElement: HTMLMediaElement): void;

  /**
   * Set CMSD manager.
   *
   * @param  cmsdManager
   * @exportDoc
   */
  setCmsdManager(cmsdManage: CmsdManager): void;

  /**
   * Sets the ABR configuration.
   *
   * It is the responsibility of the AbrManager implementation to implement the
   * restrictions behavior described in shaka.extern.AbrConfiguration.
   *
   * @param {shaka.extern.AbrConfiguration} config
   * @exportDoc
   */
  configure(config: AbrConfiguration): void;
}

/**
 * A callback into the Player that should be called when the AbrManager decides
 * it's time to change to a different variant.
 *
 * The first argument is a variant to switch to.
 *
 * The second argument is an optional boolean. If true, all data will be removed
 * from the buffer, which will result in a buffering event. Unless a third
 * argument is passed.
 *
 * The third argument in an optional number that specifies how much data (in
 * seconds) should be retained when clearing the buffer. This can help achieve
 * a fast switch that doesn't involve a buffering event. A minimum of two video
 * segments should always be kept buffered to avoid temporary hiccups.
 *
 * @exportDoc
 */
export type SwitchCallback = (variant: Variant, clearBuffer: boolean, bufferLength: number) => void;

/**
 * A factory for creating the abr manager.
 *
 * @exportDoc
 */
export type AbrManagerFactory = () => AbrManager;
