/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { asserts } from '../debug/asserts';
import { log } from '../debug/log';
import { Enforcer } from './enforcer';
import { Version } from './version';

/**
 * |shaka.Deprecate| is the front-end of the deprecation system, allowing for
 * any part of the code to say that "this block of code should be removed by
 * version X".
 *
 * @final
 */
export class Deprecate {
  /**
   * The global deprecation enforcer that will be set by the player (because the
   * player knows the version) when it calls |init|. This may appear a little
   * round-about to you, because it is. Since player uses |Deprecate|, it means
   * that |Deprecate| can't depend on Player directly.
   *
   */
  static enforcer_: Enforcer | null = null;

  /**
   * Initialize the system. This must happen before any calls to |enforce|. In
   * our code base, |shaka.Player| will be the only one to call this (it has the
   * version string).
   *
   * If the |Deprecate| called |Player.version| to initialize itself, it would
   * mean that |Player| could not use |Deprecate| because it would create a
   * circular dependency. To work around this, we provide this method so that
   * |Player| can give us the version without us needing to know about |Player|.
   *
   * This will initialize the system to:
   *  - print warning messages when the feature is scheduled to be removed in a
   *    later version
   *  - print errors and fail assertions when the feature should be removed now
   *
   * @param {string} versionString
   */
  static init(versionString: string) {
    asserts.assert(
      Deprecate.enforcer_ === null,
      'Deprecate.init should only be called once.'
    );

    Deprecate.enforcer_ = new Enforcer(
      Version.parse(versionString),
      Deprecate.onPending_,
      Deprecate.onExpired_
    );
  }

  /**
   * Ask the deprecation system to require this feature to be removed by the
   * given version.
   *
   * @param {number} major
   * @param {string} name
   * @param {string} description
   */
  static deprecateFeature(major: number, name: string, description: string) {
    const enforcer = Deprecate.enforcer_;
    asserts.assert(
      enforcer,
      'Missing deprecation enforcer. Was |init| called?'
    );

    const expiresAt = new Version(major, 0);
    enforcer!.enforce(expiresAt, name, description);
  }

  /**
   * This is called when a feature is pending. This will print a warning.
   *
   * @private
   */
  private static onPending_(
    libraryVersion: Version,
    featureVersion: Version,
    name: string,
    description: string
  ) {
    // If we were to pass each value to the log call, it would be printed as
    // a comma-separated list. To make the print state appear more natural to
    // the reader, create one string for the message.
    log.alwaysWarn(
      [
        name,
        'has been deprecated and will be removed in',
        featureVersion,
        '. We are currently at version',
        libraryVersion,
        '. Additional information:',
        description,
      ].join(' ')
    );
  }

  /**
   * This is called when a feature is expired. This will print an error and
   * then fail an assertion.
   *
   * @private
   */
  private static onExpired_(
    libraryVersion: Version,
    featureVersion: Version,
    name: string,
    description: string
  ) {
    // If we were to pass each value to the log call, it would be printed as
    // a comma-separated list. To make the print state appear more natural to
    // the reader, create one string for the message.
    const errorMessage = [
      name,
      'has been deprecated and has been removed in',
      featureVersion,
      '. We are now at version',
      libraryVersion,
      '. Additional information:',
      description,
    ].join(' ');

    log.alwaysError(errorMessage);
    asserts.assert(false, errorMessage);
  }
}
