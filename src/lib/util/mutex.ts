import { log } from '../debug/log';

export class Mutex {
  acquiredIdentifier: string | null = null;
  unlockQueue: Function[] = [];
  /**
   * Acquires the mutex, as soon as possible.
   * @param {string} identifier
   * @return {Promise}
   */
  async acquire(identifier: string) {
    log.v2(identifier + ' has requested mutex');
    if (this.acquiredIdentifier) {
      log.v2(identifier + ' is waiting for mutex');
      await new Promise((resolve) => {
        this.unlockQueue.push(resolve);
      });
    }
    this.acquiredIdentifier = identifier;
    log.v2(identifier + ' has acquired mutex');
  }
  /**
   * Releases your hold on the mutex.
   */
  release() {
    log.v2(this.acquiredIdentifier + ' has released mutex');
    if (this.unlockQueue.length) {
      const resolve = this.unlockQueue.shift();
      if (resolve) {
        resolve();
      }
    } else {
      this.acquiredIdentifier = null;
    }
  }
  /**
   * Completely releases the mutex. Meant for use by the tests.
   */
  releaseAll() {
    while (this.acquiredIdentifier) {
      this.release();
    }
  }
}
