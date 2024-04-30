/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @externs
 */

/**
 * @typedef {{
 *   hasAppRestrictions: boolean,
 *   missingKeys: !Array.<string>,
 *   restrictedKeyStatuses: !Array.<string>
 * }}
 *
 * @property {boolean} hasAppRestrictions
 *   Whether there are streams that are restricted due to app-provided
 *   restrictions.
 * @property {!Array.<string>} missingKeys
 *   The key IDs that were missing.
 * @property {!Array.<string>} restrictedKeyStatuses
 *   The restricted EME key statuses that the streams had.  For example,
 *   'output-restricted' would mean streams couldn't play due to restrictions
 *   on the output device (e.g. HDCP).
 * @exportDoc
 */
export interface RestrictionInfo {
  hasAppRestrictions: boolean;
  missingKeys: string[];
  restrictedKeyStatuses: string[];
}

/**
 * @interface
 * @exportDoc
 */
export interface Error {
  /**
   * @type {shaka.util.Error.Severity}
   * @exportDoc
   */
  severity: number;

  /**
   * @const {shaka.util.Error.Category}
   * @exportDoc
   */
  category: number;

  /**
   * @const {shaka.util.Error.Code}
   * @exportDoc
   */
  code: number;

  /**
   * @const {!Array.<*>}
   * @exportDoc
   */
  data: any[];

  /**
   * @type {boolean}
   * @exportDoc
   */
  handled: boolean;
}
