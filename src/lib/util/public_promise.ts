/**
 * @summary
 * A utility to create Promises with convenient public resolve and reject
 * methods.
 *
 */

export class PublicPromise<T = void, R = any> {
  constructor() {
    let resolvePromise!: (value: T | PromiseLike<T>) => void;
    let rejectPromise!: (reason?: R) => void;

    // Promise.call causes an error.  It seems that inheriting from a native
    // Promise is not permitted by JavaScript interpreters.

    // The work-around is to construct a Promise object, modify it to look like
    // the compiler's picture of PublicPromise, then return it.  The caller of
    // new PublicPromise will receive |promise| instead of |this|, and the
    // compiler will be aware of the additional properties |resolve| and
    // |reject|.

    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    // Now cast the Promise object to our subclass PublicPromise so that the
    // compiler will permit us to attach resolve() and reject() to it.
    const publicPromise = promise as unknown as PublicPromise<T, R>;
    publicPromise.resolve = resolvePromise;
    publicPromise.reject = rejectPromise;

    return publicPromise;
  }

  resolve(value: T) {}

  reject(reason: R) {}
}
