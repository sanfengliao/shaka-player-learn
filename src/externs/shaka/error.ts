/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @externs
 */

export interface RestrictionInfo {
  /**
   *  Whether there are streams that are restricted due to app-provided
   * restrictions.
   */
  hasAppRestrictions: boolean;
  // The key IDs that were missing.
  missingKeys: string[];
  /**
   * The restricted EME key statuses that the streams had.  For example,
   * 'output-restricted' would mean streams couldn't play due to restrictions
   * on the output device (e.g. HDCP).
   */
  restrictedKeyStatuses: string[];
}

/**
 * @interface
 * @exportDoc
 */
export interface Error {
  severity: number;

  category: number;

  code: number;

  data: any[];

  handled: boolean;
}
