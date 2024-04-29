/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { asserts } from './asserts';

/**
 * @summary
 * A console logging framework which is compiled out for deployment.  This is
 * only available when using the uncompiled version.
 * @exportDoc
 */

const Level = {
  NONE: 0,
  ERROR: 1,
  WARNING: 2,
  INFO: 3,
  DEBUG: 4,
  V1: 5,
  V2: 6,
};
export const log = {
  /**
   * This always logs to the console, even in Release mode.  This should only be
   * used for deprecation messages and things the app should never ignore.
   *
   * @param {...*} args
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  alwaysError(...args: any[]) {},

  /**
   * This always logs to the console, even in Release mode.  This should only be
   * used for deprecation messages and things the app should never ignore.
   *
   * @param {...*} args
   */
  alwaysWarn(...args: any[]) {},

  /**
   * This always logs to the console, even in Release mode.  This should only be
   * used for deprecation messages and things the app should never ignore.
   *
   * @param {string} id
   * @param {...*} args
   */
  warnOnce(id: string, ...args: any[]) {
    if (log.oneTimeWarningIssued_.has(id)) {
      return;
    }

    log.oneTimeWarningIssued_.add(id);
    log.alwaysWarn(...args);
  },

  /**
   * This log is for when an error occurs.  This should always be accompanied
   * with an error event, thrown exception, or rejected Promise.  Logs are
   * disabled in Release mode, so there should be other methods of detecting the
   * error.
   *
   * @param {...*} args
   */
  error(...args: any[]) {},

  /**
   * This log is for possible errors or things that may be surprising to a user.
   * For example, if we work around unusual or bad content, we should warn that
   * they should fix their content.  Deprecation messages and messages the app
   * shouldn't ignore should use alwaysWarn instead.
   *
   * @param {...*} args
   */
  warning(...args: any[]) {},

  /**
   * This log is for messages to the user about what is happening.  For example,
   * when we update a manifest or install a polyfill.
   *
   * @param {...*} args
   */
  info(...args: any[]) {},

  /**
   * This log is to aid *users* in debugging their content.  This should be for
   * logs about the content and what we do with it.  For example, when we change
   * streams or what we are choosing.
   *
   * @param {...*} args
   */
  debug(...args: any[]) {},

  /**
   * This log is for debugging Shaka Player itself.  This may be logs about
   * internal states or events.  This may also be for more verbose logs about
   * content, such as for segment appends.
   *
   * @param {...*} args
   */
  v1(...args: any[]) {},

  /**
   * This log is for tracing and debugging Shaka Player.  These logs will happen
   * a lot, for example, logging every segment append or every update check.
   * These are mostly used for tracking which calls happen through the code.
   *
   * @param {...*} args
   */
  v2(...args: any[]) {},
  Level: Level,
  MAX_LOG_LEVEL: 3,
  oneTimeWarningIssued_: new Set(),
  logMap_: {
    [Level.ERROR]: (...args: any[]) => console.error(...args),
    [Level.WARNING]: (...args: any[]) => console.warn(...args),
    [Level.INFO]: (...args: any[]) => console.info(...args),
    [Level.DEBUG]: (...args: any[]) => console.log(...args),
    [Level.V1]: (...args: any[]) => console.debug(...args),
    [Level.V2]: (...args: any[]) => console.debug(...args),
  },
  currentLevel: 3,
  setLevel: (level: number) => {},
};

log.alwaysWarn = (...args: any[]) => console.warn(...args);
log.alwaysError = (...args: any[]) => console.error(...args);

if (__DEV__) {
  // Since we don't want to export log in production builds, we don't
  // use the @export annotation.  But the module wrapper (used in debug builds
  // since v2.5.11) hides anything non-exported.  This is a debug-only,
  // API-based export to make sure logging is available in debug builds.

  /**
   * Change the log level.  Useful for debugging in uncompiled mode.
   *
   * @param {number} level
   * @exportDoc
   */
  log.setLevel = (level) => {
    const getLog = (curLevel: number) => {
      if (curLevel <= level) {
        asserts.assert(log.logMap_[curLevel], 'Unexpected log level');
        return log.logMap_[curLevel];
      } else {
        return () => {};
      }
    };

    log.currentLevel = level;
    log.error = getLog(log.Level.ERROR);
    log.warning = getLog(log.Level.WARNING);
    log.info = getLog(log.Level.INFO);
    log.debug = getLog(log.Level.DEBUG);
    log.v1 = getLog(log.Level.V1);
    log.v2 = getLog(log.Level.V2);
  };

  log.setLevel(log.MAX_LOG_LEVEL);
} else {
  if (log.MAX_LOG_LEVEL >= log.Level.ERROR) {
    log.error = log.logMap_[log.Level.ERROR];
  }
  if (log.MAX_LOG_LEVEL >= log.Level.WARNING) {
    log.warning = log.logMap_[log.Level.WARNING];
  }
  if (log.MAX_LOG_LEVEL >= log.Level.INFO) {
    log.info = log.logMap_[log.Level.INFO];
  }
  if (log.MAX_LOG_LEVEL >= log.Level.DEBUG) {
    log.debug = log.logMap_[log.Level.DEBUG];
  }
  if (log.MAX_LOG_LEVEL >= log.Level.V1) {
    log.v1 = log.logMap_[log.Level.V1];
  }
  if (log.MAX_LOG_LEVEL >= log.Level.V2) {
    log.v2 = log.logMap_[log.Level.V2];
  }
}
