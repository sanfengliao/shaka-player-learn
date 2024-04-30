/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { DelayedTick } from './delayed_tick';

/**
 * A timer allows a single function to be executed at a later time or at
 * regular intervals.
 *
 * @final
 * @export
 */
export class Timer {
  /**
   * Each time our timer "does work", we call that a "tick". The name comes
   * from old analog clocks.
   */
  private onTick_: () => void;

  static activeTimers: Map<Timer, string | undefined>;
  ticker_: DelayedTick | null;
  /**
   * Create a new timer. A timer is committed to a single callback function.
   * While there is no technical reason to do this, it is far easier to
   * understand and use timers when they are connected to one functional idea.
   *
   * @param {function()} onTick
   */
  constructor(onTick: () => void) {
    this.onTick_ = onTick;

    this.ticker_ = null;
  }

  /**
   * Have the timer call |onTick| now.
   *
   * @return {!shaka.util.Timer}
   * @export
   */
  tickNow() {
    this.stop();
    this.onTick_();

    return this;
  }

  /**
   * Have the timer call |onTick| after |seconds| has elapsed unless |stop| is
   * called first.
   *
   * @export
   */
  tickAfter(seconds: number) {
    this.stop();

    this.ticker_ = new DelayedTick(() => {
      this.onTick_();
    }).tickAfter(seconds);

    return this;
  }

  /**
   * Have the timer call |onTick| every |seconds| until |stop| is called.
   *
   * @param {number} seconds
   * @return {!shaka.util.Timer}
   * @export
   */
  tickEvery(seconds: number) {
    this.stop();

    if (__DEV__) {
      // Capture the stack trace by making a fake error.
      const stackTrace = Error('Timer created').stack;
      Timer.activeTimers.set(this, stackTrace);
    }
    this.ticker_ = new DelayedTick(() => {
      // Schedule the timer again first. |onTick_| could cancel the timer and
      // rescheduling first simplifies the implementation.
      this.ticker_!.tickAfter(seconds);
      this.onTick_();
    }).tickAfter(seconds);

    return this;
  }

  /**
   * Stop the timer and clear the previous behaviour. The timer is still usable
   * after calling |stop|.
   *
   * @export
   */
  stop() {
    if (this.ticker_) {
      this.ticker_.stop();
      this.ticker_ = null;
    }
    if (__DEV__) {
      Timer.activeTimers.delete(this);
    }
  }
}

if (__DEV__) {
  /**
   * Tracks all active timer instances, along with the stack trace that created
   * that timer.
   * @type {!Map.<!shaka.util.Timer, string>}
   */
  Timer.activeTimers = new Map();
}
