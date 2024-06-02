/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// @ts-ignore
import EncryptionSchemePolyfills from 'eme-encryption-scheme-polyfill';
import { polyfill } from './all';

/**
 * @summary A polyfill to add support for EncryptionScheme queries in EME.
 * @see https://wicg.github.io/encrypted-media-encryption-scheme/
 * @see https://github.com/w3c/encrypted-media/pull/457
 * @see https://github.com/shaka-project/eme-encryption-scheme-polyfill
 * @export
 */
class EncryptionScheme {
  /**
   * Install the polyfill if needed.
   *
   * @suppress {missingRequire}
   * @export
   */
  static install() {
    EncryptionSchemePolyfills.install();
  }
}

// Install at a low priority so that other EME polyfills go first.
polyfill.register(EncryptionScheme.install, -2);
