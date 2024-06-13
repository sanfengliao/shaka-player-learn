/**
 *  A utility class to help work with |shaka.util.IDestroyable| objects.
 */

import { ShakaError } from './error';
import { PublicPromise } from './public_promise';

type DestroyCallback = () => Promise<void>;
export class Destroyer {
  private destroyed_ = false;
  private waitOnDestroy_ = new PublicPromise();
  private onDestroy_: DestroyCallback;

  /**
   * A callback to destroy an object. This callback will only be called once
   * regardless of how many times |destroy| is called.
   */
  constructor(callback: DestroyCallback) {
    this.onDestroy_ = callback;
  }

  /**
   * Check if |destroy| has been called. This returning |true| does not mean
   * that the promise returned by |destroy| has resolved yet.
   *
   */
  destroyed() {
    return this.destroyed_;
  }

  /**
   * Request that the destroy callback be called. Will return a promise that
   * will resolve once the callback terminates. The promise will never be
   * rejected.
   */
  destroy() {
    if (this.destroyed_) {
      return this.waitOnDestroy_;
    }
    this.destroyed_ = true;
    this.onDestroy_().then(
      () => {
        this.waitOnDestroy_.resolve();
      },
      () => {
        this.waitOnDestroy_.resolve();
      }
    );
  }
  /**
   * Checks if the object is destroyed and throws an error if it is.
   * @param error The inner error, if any.
   */
  ensureNotDestroyed(error: any) {
    if (this.destroyed_) {
      if (error instanceof ShakaError && error.code == ShakaError.Code.OBJECT_DESTROYED) {
        throw error;
      }
      throw Destroyer.destroyedError(error);
    }
  }

  static destroyedError(error: ShakaError) {
    return new ShakaError(
      ShakaError.Severity.CRITICAL,
      ShakaError.Category.PLAYER,
      ShakaError.Code.OBJECT_DESTROYED,
      error
    );
  }
}
