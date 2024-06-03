import { ShakaError } from './error';
import { PublicPromise } from './public_promise';

export class AbortableOperation<T> {
  promise: Promise<T>;
  private onAbort_: () => Promise<any>;
  private aborted_ = false;

  /**
   * @param {!Promise.<T>} promise
   *   A Promise which represents the underlying operation.  It is resolved when
   *   the operation is complete, and rejected if the operation fails or is
   *   aborted.  Aborted operations should be rejected with a shaka.util.Error
   *   object using the error code OPERATION_ABORTED.
   * @param {function():!Promise} onAbort
   *   Will be called by this object to abort the underlying operation.
   *   This is not cancelation, and will not necessarily result in any work
   *   being undone.  abort() should return a Promise which is resolved when the
   *   underlying operation has been aborted.  The returned Promise should never
   *   be rejected.
   */
  constructor(promise: Promise<T>, onAbort: () => Promise<any>) {
    this.promise = promise;
    this.onAbort_ = onAbort;
  }

  /**
   * @param error
   * @return  An operation which has already
   *   failed with the error given by the caller.
   * @export
   */
  static failed(error: Error) {
    return new AbortableOperation(Promise.reject(error), () =>
      Promise.resolve()
    );
  }

  /**
   * @return {!shaka.util.AbortableOperation} An operation which has already
   *   failed with the error OPERATION_ABORTED.
   * @export
   */
  static aborted() {
    const p = Promise.reject(AbortableOperation.abortError());
    // Silence uncaught rejection errors, which may otherwise occur any place
    // we don't explicitly handle aborted operations.
    p.catch(() => {});
    return new AbortableOperation(p, () => Promise.resolve());
  }

  static abortError() {
    return new ShakaError(
      ShakaError.Severity.CRITICAL,
      ShakaError.Category.PLAYER,
      ShakaError.Code.OPERATION_ABORTED
    );
  }
  /**
   * @param  value
   * @return  An operation which has already
   *   completed with the given value.
   * @template U
   * @export
   */
  static completed<U>(value: U) {
    return new AbortableOperation(Promise.resolve(value), () =>
      Promise.resolve()
    );
  }

  /**
   * @param  promise
   * @return  An operation which cannot be
   *   aborted.  It will be completed when the given Promise is resolved, or
   *   will be failed when the given Promise is rejected.
   * @template U
   * @export
   */
  static notAbortable<U>(promise: Promise<U>) {
    return new AbortableOperation(
      promise,
      // abort() here will return a Promise which is resolved when the input
      // promise either resolves or fails.
      () => promise.catch(() => {})
    );
  }

  abort() {
    this.aborted_ = true;
    return this.onAbort_();
  }

  /**
   * @param {} operations
   * @return {!shaka.util.AbortableOperation} An operation which is resolved
   *   when all operations are successful and fails when any operation fails.
   *   For this operation, abort() aborts all given operations.
   * @export
   */
  static all<U>(operations: AbortableOperation<U>[]) {
    return new AbortableOperation(
      Promise.all(operations.map((op) => op.promise)),
      () => Promise.all(operations.map((op) => op.abort()))
    );
  }

  finally(onFinal: (success: boolean) => {}) {
    this.promise.then(
      (value) => onFinal(true),
      (e) => onFinal(false)
    );
    return this;
  }

  /**
   * @param onSuccess
   *   A callback to be invoked after this operation is complete, to chain to
   *   another operation.  The callback can return a plain value, a Promise to
   *   an asynchronous value, or another AbortableOperation.
   * @param  onError
   *   An optional callback to be invoked if this operation fails, to perform
   *   some cleanup or error handling.  Analogous to the second parameter of
   *   Promise.prototype.then.
   * @return An operation which is resolved
   *   when this operation and the operation started by the callback are both
   *   complete.
   */
  chain<T, U>(
    onSuccess?:
      | ((param: T) => U)
      | ((param: T) => Promise<U>)
      | ((param: T) => AbortableOperation<U>),
    onError?: () => void
  ): AbortableOperation<U> {
    const newPromise = new PublicPromise();
    const abortError = AbortableOperation.abortError();
    let abort = () => {
      newPromise.reject(abortError);
      return this.abort();
    };

    const makeCallback = (isSuccess: boolean) => {
      return (value: any) => {
        if (this.aborted_ && isSuccess) {
          // If "this" is not abortable(), or if abort() is called after "this"
          // is complete but before the next stage in the chain begins, we
          // should stop right away.
          newPromise.reject(abortError);
        }

        const cb = isSuccess ? onSuccess : onError;
        if (!cb) {
          // No callback?  Pass it along.
          const next = isSuccess ? newPromise.resolve : newPromise.reject;
          next(value);
          return;
        }

        abort = AbortableOperation.wrapChainCallback_(cb, value, newPromise);
      };
    };

    this.promise.then(makeCallback(true), makeCallback(false));

    return new AbortableOperation(
      newPromise as unknown as Promise<any>,
      // By creating a closure around abort(), we can update the value of
      // abort() at various stages.
      () => abort()
    );
  }
  /**
   *
   * @param callback A callback to be invoked with the given value.
   * @param value
   * @param newPromise The promise for the next
   *   stage in the chain.
   * @return The next abort() function for the chain.
   */
  static wrapChainCallback_<T, U>(
    callback:
      | ((param: T) => U)
      | ((param: T) => Promise<U>)
      | ((param: T) => AbortableOperation<U>)
      | ((...params: any[]) => any),
    value: T,
    newPromise: PublicPromise
  ): () => Promise<any> {
    try {
      const ret = callback(value);
      if (ret instanceof AbortableOperation) {
        newPromise.resolve(ret.promise);
        // This is an abortable operation, with its own abort() method.
        // After this point, abort() should abort the operation from the
        // callback, and the new promise should be tied to the promise
        // from the callback's operation.
        newPromise.resolve(ret.promise);
        // This used to say "return ret.abort;", but it caused subtle issues by
        // unbinding part of the abort chain.  There is now a test to ensure
        // that we don't call abort with the wrong "this".
        return () => ret.abort();
      } else {
        // This is a Promise or a plain value, and this step cannot be aborted.
        newPromise.resolve(ret);
        // Abort is complete when the returned value/Promise is resolved or
        // fails, but never fails itself nor returns a value.
        return () =>
          Promise.resolve(ret).then(
            () => {},
            () => {}
          );
      }
    } catch (error) {
      newPromise.reject(error);
      return () => Promise.resolve();
    }
  }
}
