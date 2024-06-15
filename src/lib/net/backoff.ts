import { RetryParameters } from '../../externs/shaka/net';
import { asserts } from '../debug/asserts';
import { ShakaError } from '../util/error';
import { Timer } from '../util/timer';

export class Backoff {
  private maxAttempts_: number;
  private baseDelay_: number;
  private fuzzFactor_: number;
  private backoffFactor_: number;
  private numAttempts_ = 0;

  private nextUnfuzzedDelay_: number;
  private autoReset_: boolean;

  constructor(parameters: RetryParameters, autoReset = false) {
    const defaults = Backoff.defaultRetryParameters();

    this.maxAttempts_ = parameters.maxAttempts ?? defaults.maxAttempts;
    asserts.assert(this.maxAttempts_ >= 1, 'maxAttempts should be >= 1');

    this.baseDelay_ = parameters.baseDelay ?? defaults.baseDelay;
    asserts.assert(this.baseDelay_ >= 0, 'baseDelay should be >= 0');

    this.fuzzFactor_ = parameters.fuzzFactor ?? defaults.fuzzFactor;
    asserts.assert(this.fuzzFactor_ >= 0, 'fuzzFactor should be >= 0');

    this.backoffFactor_ = parameters.backoffFactor ?? defaults.backoffFactor;
    asserts.assert(this.backoffFactor_ >= 0, 'backoffFactor should be >= 0');

    this.nextUnfuzzedDelay_ = this.baseDelay_;

    this.autoReset_ = autoReset;

    if (this.autoReset_) {
      // There is no delay before the first attempt.  In StreamingEngine (the
      // intended user of auto-reset mode), the first attempt was implied, so we
      // reset numAttempts to 1.  Therefore maxAttempts (which includes the
      // first attempt) must be at least 2 for us to see a delay.
      asserts.assert(this.maxAttempts_ >= 2, 'maxAttempts must be >= 2 for autoReset == true');
      this.numAttempts_ = 1;
    }
  }

  /**
   * @return {!Promise} Resolves when the caller may make an attempt, possibly
   *   after a delay.  Rejects if no more attempts are allowed.
   */
  async attempt() {
    if (this.numAttempts_ >= this.maxAttempts_) {
      if (this.autoReset_) {
        this.reset_();
      } else {
        throw new ShakaError(
          ShakaError.Severity.CRITICAL,
          ShakaError.Category.PLAYER,
          ShakaError.Code.ATTEMPTS_EXHAUSTED
        );
      }
    }

    const currentAttempt = this.numAttempts_;

    if (currentAttempt === 0) {
      asserts.assert(!this.autoReset_, 'Failed to delay with auto-reset!');
      return;
    }

    // We've already tried before, so delay the Promise.

    // Fuzz the delay to avoid tons of clients hitting the server at once
    // after it recovers from whatever is causing it to fail.
    const fuzzDelayMs = Backoff.fuzz_(this.nextUnfuzzedDelay_, this.fuzzFactor_);

    await new Promise<void>((resolve) => {
      Backoff.defer(fuzzDelayMs, resolve);
    });

    // Update delay_ for next time.
    this.nextUnfuzzedDelay_ *= this.backoffFactor_;
  }

  /**
   * Reset state in autoReset mode.
   * @private
   */
  private reset_() {
    asserts.assert(this.autoReset_, 'Should only be used for auto-reset!');
    this.numAttempts_ = 1;
    this.nextUnfuzzedDelay_ = this.baseDelay_;
  }

  static fuzz_(value: number, fuzzFactor: number) {
    // A random number between -1 and +1.
    const negToPosOne = Math.random() * 2.0 - 1.0;

    // A random number between -fuzzFactor and +fuzzFactor.
    const negToPosFuzzFactor = negToPosOne * fuzzFactor;

    // The original value, fuzzed by +/- fuzzFactor.
    return value * (1.0 + negToPosFuzzFactor);
  }

  /**
   * This method is only public for testing. It allows us to intercept the
   * time-delay call.
   *
   * @param delayInMs
   * @param callback
   */

  static defer(delayInMs: number, callback: () => void) {
    const timer = new Timer(callback);

    timer.tickAfter(delayInMs / 1000);
  }
  /**
   * Gets a copy of the default retry parameters.
   *
   * @return
   */
  static defaultRetryParameters(): RetryParameters {
    // Use a function rather than a constant member so the calling code can
    // modify the values without affecting other call results.
    return {
      maxAttempts: 2,
      baseDelay: 1000,
      backoffFactor: 2,
      fuzzFactor: 0.5,
      timeout: 30000,
      stallTimeout: 5000,
      connectionTimeout: 10000,
    };
  }
}
