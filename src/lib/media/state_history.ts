/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { StateChange } from '../../externs/shaka';
import { asserts } from '../debug/asserts';
import { log } from '../debug/log';

/**
 * This class is used to track the time spent in arbitrary states. When told of
 * a state, it will assume that state was active until a new state is provided.
 * When provided with identical states back-to-back, the existing entry will be
 * updated.
 *
 * @final
 */
export class StateHistory {
  /**
   * The state that we think is still the current change. It is "open" for
   * updating.
   */
  private open_: StateChange = null as any;
  /**
   * The stats that are "closed" for updating. The "open" state becomes closed
   * once we move to a new state.
   */
  private closed_: StateChange[] = [];

  /**
   * @param state
   * @return True if this changed the state
   */
  update(state: string) {
    // |open_| will only be |null| when we first call |update|.
    if (this.open_ === null) {
      this.start_(state);
      return true;
    } else {
      return this.update_(state);
    }
  }

  /**
   * Go through all entries in the history and count how much time was spend in
   * the given state.
   *
   * @param state
   * @return
   */
  getTimeSpentIn(state: string) {
    let sum = 0;

    if (this.open_ && this.open_.state == state) {
      sum += this.open_.duration;
    }

    for (const entry of this.closed_) {
      sum += entry.state == state ? entry.duration : 0;
    }

    return sum;
  }

  /**
   * Get a copy of each state change entry in the history. A copy of each entry
   * is created to break the reference to the internal data.
   *
   */
  getCopy(): StateChange[] {
    const clone = (entry: StateChange) => {
      return {
        timestamp: entry.timestamp,
        state: entry.state,
        duration: entry.duration,
      };
    };

    const copy = [];
    for (const entry of this.closed_) {
      copy.push(clone(entry));
    }
    if (this.open_) {
      copy.push(clone(this.open_));
    }

    return copy;
  }

  /**
   * @param {string} state
   * @private
   */
  private start_(state: string) {
    asserts.assert(this.open_ == null, 'There must be no open entry in order when we start');
    log.v1('Changing Player state to', state);

    this.open_ = {
      timestamp: this.getNowInSeconds_(),
      state: state,
      duration: 0,
    };
  }

  /**
   * @param {string} state
   * @return {boolean} True if this changed the state
   * @private
   */
  update_(state: string) {
    asserts.assert(this.open_, 'There must be an open entry in order to update it');

    const currentTimeSeconds = this.getNowInSeconds_();

    // Always update the duration so that it can always be as accurate as
    // possible.
    this.open_.duration = currentTimeSeconds - this.open_.timestamp;

    // If the state has not changed, there is no need to add a new entry.
    if (this.open_.state == state) {
      return false;
    }

    // We have changed states, so "close" the open state.
    log.v1('Changing Player state to', state);
    this.closed_.push(this.open_);
    this.open_ = {
      timestamp: currentTimeSeconds,
      state: state,
      duration: 0,
    };
    return true;
  }

  /**
   * Get the system time in seconds.
   *
   */
  getNowInSeconds_() {
    return Date.now() / 1000;
  }
}
