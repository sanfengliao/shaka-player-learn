/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { TextDisplayerConfiguration } from '.';
import { Cue } from '../../lib/text/cue';

/**
 * @externs
 */

/**
 * An interface for plugins that parse text tracks.
 *
 * @interface
 * @exportDoc
 */
export interface TextParser {
  /**
   * Parse an initialization segment. Some formats do not have init
   * segments so this won't always be called.
   *
   * @param {!Uint8Array} data
   *    The data that makes up the init segment.
   *
   * @exportDoc
   */
  parseInit(data: Uint8Array): void;

  /**
   * Parse a media segment and return the cues that make up the segment.
   *
   * @param {!Uint8Array} data
   *    The next section of buffer.
   * @param  timeContext
   *    The time information that should be used to adjust the times values
   *    for each cue.
   * @param  uri The media uri.
   * @return {!Array.<!shaka.text.Cue>}
   *
   * @exportDoc
   */
  parseMedia(data: Uint8Array, timeContext: TimeContext, uri?: string): Cue[];

  /**
   * Notifies the stream if the manifest is in sequence mode or not.
   *
   * @param {boolean} sequenceMode
   */
  setSequenceMode(sequenceMode: boolean): void;

  /**
   * Notifies the manifest type.
   *
   * @param {string} manifestType
   */
  setManifestType(manifestType: string): void;
}

/**
 * A collection of time offsets used to adjust text cue times.
 */
export interface TimeContext {
  // The absolute start time of the period in seconds.
  periodStart: number;
  // The absolute start time of the segment in seconds.
  segmentStart: number;
  // The absolute end time of the segment in seconds.
  segmentEnd: number;
  /**
   * The start time relative to either segment or period start depending
   * on <code>segmentRelativeVttTiming</code> configuration.
   */
  vttOffset: number;
}

/**
 * A callback used for editing cues before appending.
 * Provides the cue, the URI of the captions file the cue was parsed from, and
 * the time context that was used when generating that cue.
 * You can edit the cue object passed in.
 * @exportDoc
 */
export type ModifyCueCallback = (cue: Cue, uri?: string | null, timeContext?: TimeContext) => void;

/**
 * @typedef {function():!shaka.extern.TextParser}
 * @exportDoc
 */
export type TextParserPlugin = () => TextParser;

/**
 * @summary
 * An interface for plugins that display text.
 *
 * @description
 * This should handle displaying the text cues on the page.  This is given the
 * cues to display and told when to start and stop displaying.  This should only
 * display the cues it is given and remove cues when told to.
 *
 * <p>
 * This should only change whether it is displaying the cues through the
 * <code>setTextVisibility</code> function; the app should not change the text
 * visibility outside the top-level Player methods.  If you really want to
 * control text visibility outside the Player methods, you must set the
 * <code>streaming.alwaysStreamText</code> Player configuration value to
 * <code>true</code>.
 * @exportDoc
 */
export interface TextDisplayer {
  /**
   * @override
   * @exportDoc
   */
  destroy(): void;

  /**
   * Sets the TextDisplayer configuration.
   *
   * @param {shaka.extern.TextDisplayerConfiguration} config
   */
  configure(config: TextDisplayerConfiguration): void;

  /**
   * Append given text cues to the list of cues to be displayed.
   *
   * @param cues
   *    Text cues to be appended.
   *
   * @exportDoc
   */
  append(cues: Cue[]): void;

  /**
   * Remove all cues that are fully contained by the given time range (relative
   * to the presentation). <code>endTime</code> will be greater to equal to
   * <code>startTime</code>.  <code>remove</code> should only return
   * <code>false</code> if the displayer has been destroyed. If the displayer
   * has not been destroyed <code>remove</code> should return <code>true</code>.
   *
   * @param {number} startTime
   * @param {number} endTime
   *
   * @return {boolean}
   *
   * @exportDoc
   */
  remove(startTime: number, endTime: number): boolean;

  /**
   * Returns true if text is currently visible.
   *
   * @return {boolean}
   *
   * @exportDoc
   */
  isTextVisible(): boolean;

  /**
   * Set text visibility.
   *
   * @param {boolean} on
   *
   * @exportDoc
   */
  setTextVisibility(on: boolean): void;
}

/**
 * A factory for creating a TextDisplayer.
 *
 * @exportDoc
 */
export type TextDisplayerFactory = () => TextDisplayer;
