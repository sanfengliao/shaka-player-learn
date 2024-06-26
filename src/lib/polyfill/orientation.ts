/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { log } from '../debug/log';
import { FakeEvent } from '../util/fake_event';
import { FakeEventTarget } from '../util/fake_event_target';
import { polyfill } from './all';

/**
 * @summary A polyfill for systems that do not implement screen.orientation.
 * For now, this only handles systems that implement the deprecated
 * window.orientation feature... e.g. iPad.
 * @export
 */
export class Orientation {
  /**
   * Install the polyfill if needed.
   * @export
   */
  static install() {
    // @ts-expect-error
    if (screen.orientation && screen.orientation.unlock) {
      // Not needed.
      log.info('Using native screen.orientation');
      return;
    }

    if (screen.orientation != undefined) {
      // There are some platforms where screen.orientation is defined but
      // incomplete (e.g. Safari).
      // Install a very simple polyfill in that case.
      Orientation.installBasedOnScreenMethods_();
    } else if (window.orientation != undefined) {
      // There is no way to check to see if the 'orientationchange' event exists
      // on window, which could theoretically lead to this making a
      // screen.orientation object that doesn't actually work.
      // However, it looks like all platforms that support the deprecated
      // window.orientation feature also support that event.
      Orientation.installBasedOnWindowMethods_();
    }
  }

  /**
   * Modifies screen.orientation to add no-ops for missing methods.
   * Meant for cases where screen.orientation is defined, but has missing
   * methods that cannot be properly polyfilled.
   * @private
   */
  static installBasedOnScreenMethods_() {
    // @ts-expect-error
    if (screen.orientation.lock === undefined) {
      // @ts-expect-error
      screen.orientation.lock = (orientation) => {
        log.info('screen.orientation.lock is a no-op');
        return Promise.resolve();
      };
    }
    if (screen.orientation.unlock === undefined) {
      screen.orientation.unlock = () => {
        log.info('screen.orientation.unlock is a no-op');
      };
    }
  }

  /**
   * Makes a polyfill for orientation, based on window methods.
   * Note that some of the features this is based on are deprecated, so this
   * will not necessarily work on all platforms.
   * @private
   */
  static installBasedOnWindowMethods_() {
    const orientation = new FakeOrientation();
    // @ts-expect-error
    screen.orientation = /** @type {!ScreenOrientation} */ orientation;
    const setValues = () => {
      switch (window.orientation) {
        case -90:
          orientation.type = 'landscape-secondary';
          orientation.angle = 270;
          break;
        case 0:
          orientation.type = 'portrait-primary';
          orientation.angle = 0;
          break;
        case 90:
          orientation.type = 'landscape-primary';
          orientation.angle = 90;
          break;
        case 180:
          orientation.type = 'portrait-secondary';
          orientation.angle = 180;
          break;
      }
    };

    setValues();
    window.addEventListener('orientationchange', () => {
      setValues();
      orientation.dispatchChangeEvent();
    });
  }
}

class FakeOrientation extends FakeEventTarget {
  type: string = '';
  angle = 0;

  /** Dispatch a 'change' event. */
  dispatchChangeEvent() {
    const event = new FakeEvent('change');
    this.dispatchEvent(event);
  }

  /**
   * @param {string} orientation
   * @return {!Promise}
   */
  lock(orientation: string) {
    /**
     * @param {string} orientation
     * @return {boolean}
     */
    const lockOrientation = (orientation: string) => {
      // @ts-expect-error
      if (screen.lockOrientation) {
        // @ts-expect-error
        return screen.lockOrientation(orientation);
      }
      // @ts-expect-error
      if (screen.mozLockOrientation) {
        // @ts-expect-error
        return screen.mozLockOrientation(orientation);
      }
      // @ts-expect-error
      if (screen.msLockOrientation) {
        // @ts-expect-error
        return screen.msLockOrientation(orientation);
      }
      return false;
    };

    let success = false;
    // The set of input strings for screen.orientation.lock and for
    // screen.lockOrientation are almost, but not entirely, the same.
    switch (orientation) {
      case 'natural':
        success = lockOrientation('default');
        break;
      case 'any':
        // It's not quite clear what locking the screen orientation to 'any'
        // is supposed to mean... presumably, that's equivalent to not being
        // locked?
        success = true;
        this.unlock();
        break;
      default:
        success = lockOrientation(orientation);
        break;
    }
    // According to the docs, there "may be a delay" between the
    // lockOrientation method being called and the screen actually being
    // locked.  Unfortunately, without any idea as to how long that delay is,
    // and with no events to listen for, we cannot account for it here.
    if (success) {
      return Promise.resolve();
    }
    // Either locking was not available, or the process failed... either way,
    // reject this with a mock error.
    // This should be a DOMException, but there is not a public constructor for
    // that.  So we make this look-alike instead.
    const unsupportedKeySystemError = new Error(
      'screen.orientation.lock() is not available on this device'
    );
    unsupportedKeySystemError.name = 'NotSupportedError';
    // @ts-expect-error
    unsupportedKeySystemError['code'] = DOMException.NOT_SUPPORTED_ERR;
    return Promise.reject(unsupportedKeySystemError);
  }

  /** Unlock the screen orientation. */
  unlock() {
    // screen.unlockOrientation has a return value, but
    // screen.orientation.unlock does not. So ignore the return value.
    // @ts-expect-error
    if (screen.unlockOrientation) {
      // @ts-expect-error
      screen.unlockOrientation();
      // @ts-expect-error
    } else if (screen.mozUnlockOrientation) {
      // @ts-expect-error
      screen.mozUnlockOrientation();
      // @ts-expect-error
    } else if (screen.msUnlockOrientation) {
      // @ts-expect-error
      screen.msUnlockOrientation();
    }
  }
}

polyfill.register(Orientation.install);
