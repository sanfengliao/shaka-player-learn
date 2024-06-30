/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { DrmInfo, InitDataOverride } from '../../externs/shaka/manifest';
import { Uri } from '../../third_party/closure-uri/uri';
import { BufferUtils } from './buffer_utils';
import { ShakaError } from './error';
import { StringUtils } from './string_utils';
import { Uint8ArrayUtils } from './uint8array_utils';

/**
 * @summary Utility functions for manifest parsing.
 */
export class ManifestParserUtils {
  /**
   * Resolves an array of relative URIs to the given base URIs. This will result
   * in M*N number of URIs.
   *
   * Note: This method is slow in SmartTVs and Consoles. It should only be
   * called when necessary.
   *
   * @param baseUris
   * @param relativeUris
   * @return
   */
  static resolveUris(baseUris: string[], relativeUris: string[]) {
    if (relativeUris.length == 0) {
      return baseUris;
    }

    if (baseUris.length == 1 && relativeUris.length == 1) {
      const baseUri = new Uri(baseUris[0]);
      const relativeUri = new Uri(relativeUris[0]);
      return [baseUri.resolve(relativeUri).toString()];
    }

    const relativeAsGoog = relativeUris.map((uri) => new Uri(uri));

    // For each base URI, this code resolves it with every relative URI.
    // The result is a single array containing all the resolved URIs.
    const resolvedUris = [];
    for (const baseStr of baseUris) {
      const base = new Uri(baseStr);
      for (const relative of relativeAsGoog) {
        resolvedUris.push(base.resolve(relative).toString());
      }
    }

    return resolvedUris;
  }

  /**
   * Creates a DrmInfo object from the given info.
   *
   * @param  keySystem
   * @param  encryptionScheme
   * @param  initData
   */
  static createDrmInfo(keySystem: string, encryptionScheme: string, initData?: InitDataOverride[] | null): DrmInfo {
    return {
      keySystem,
      encryptionScheme,
      licenseServerUri: '',
      distinctiveIdentifierRequired: false,
      persistentStateRequired: false,
      audioRobustness: '',
      videoRobustness: '',
      serverCertificate: null,
      serverCertificateUri: '',
      sessionType: '',
      initData: initData || [],
      keyIds: new Set(),
    };
  }

  /**
   * Creates a DrmInfo object from ClearKeys.
   *
   * @param  clearKeys
   * @param encryptionScheme
   * @return
   */
  static createDrmInfoFromClearKeys(clearKeys: Map<string, string>, encryptionScheme = 'cenc'): DrmInfo {
    const keys: {
      kty: string;
      kid: string;
      k: string;
    }[] = [];
    const keyIds: string[] = [];
    const originalKeyIds: string[] = [];

    clearKeys.forEach((key, keyId) => {
      let kid = keyId;
      if (kid.length != 22) {
        kid = Uint8ArrayUtils.toBase64(Uint8ArrayUtils.fromHex(keyId), false);
      }
      let k = key;
      if (k.length != 22) {
        k = Uint8ArrayUtils.toBase64(Uint8ArrayUtils.fromHex(key), false);
      }
      const keyObj = {
        kty: 'oct',
        kid: kid,
        k: k,
      };

      keys.push(keyObj);
      keyIds.push(keyObj.kid);
      originalKeyIds.push(keyId);
    });

    const jwkSet = { keys: keys };
    const license = JSON.stringify(jwkSet);

    // Use the keyids init data since is suggested by EME.
    // Suggestion: https://bit.ly/2JYcNTu
    // Format: https://www.w3.org/TR/eme-initdata-keyids/
    const initDataStr = JSON.stringify({ kids: keyIds });
    const initData = BufferUtils.toUint8(StringUtils.toUTF8(initDataStr));
    const initDatas = [{ initData: initData, initDataType: 'keyids' }];

    return {
      keySystem: 'org.w3.clearkey',
      encryptionScheme,
      licenseServerUri: 'data:application/json;base64,' + window.btoa(license),
      distinctiveIdentifierRequired: false,
      persistentStateRequired: false,
      audioRobustness: '',
      videoRobustness: '',
      serverCertificate: null,
      serverCertificateUri: '',
      sessionType: '',
      initData: initDatas,
      keyIds: new Set(originalKeyIds),
    };
  }

  /**
   * Attempts to guess which codecs from the codecs list belong to a given
   * content type.
   * Assumes that at least one codec is correct, and throws if none are.
   *
   * @param contentType
   * @param codecs
   * @return
   */
  static guessCodecs(contentType: string, codecs: string[]): string {
    if (codecs.length == 1) {
      return codecs[0];
    }

    const match = ManifestParserUtils.guessCodecsSafe(contentType, codecs);
    // A failure is specifically denoted by null; an empty string represents a
    // valid match of no codec.
    if (match != null) {
      return match;
    }

    // Unable to guess codecs.
    throw new ShakaError(
      ShakaError.Severity.CRITICAL,
      ShakaError.Category.MANIFEST,
      ShakaError.Code.HLS_COULD_NOT_GUESS_CODECS,
      codecs
    );
  }

  /**
   * Attempts to guess which codecs from the codecs list belong to a given
   * content type. Does not assume a single codec is anything special, and does
   * not throw if it fails to match.
   *
   * @param contentType
   * @param codecs
   * @return or null if no match is found
   */
  static guessCodecsSafe(contentType: string, codecs: string[]) {
    const formats =
      // @ts-ignore
      ManifestParserUtils.CODEC_REGEXPS_BY_CONTENT_TYPE_[contentType];
    for (const format of formats) {
      for (const codec of codecs) {
        if (format.test(codec.trim())) {
          return codec.trim();
        }
      }
    }

    // Text does not require a codec string.
    if (contentType == ManifestParserUtils.ContentType.TEXT) {
      return '';
    }

    return null;
  }

  /**
   * Attempts to guess which codecs from the codecs list belong to a given
   * content.
   *
   * @param contentType
   * @param codecs
   * @return
   */
  static guessAllCodecsSafe(contentType: string, codecs: string[]) {
    const allCodecs = [];
    const formats = ManifestParserUtils.CODEC_REGEXPS_BY_CONTENT_TYPE_[contentType];
    for (const format of formats) {
      for (const codec of codecs) {
        if (format.test(codec.trim())) {
          allCodecs.push(codec.trim());
        }
      }
    }

    return allCodecs;
  }

  static ContentType = {
    VIDEO: 'video',
    AUDIO: 'audio',
    TEXT: 'text',
    IMAGE: 'image',
    APPLICATION: 'application',
  };

  /**
   * @enum {string}
   */
  static TextStreamKind = {
    SUBTITLE: 'subtitle',
    CLOSED_CAPTION: 'caption',
  };

  /**
   * Specifies how tolerant the player is of inaccurate segment start times and
   * end times within a manifest. For example, gaps or overlaps between segments
   * in a SegmentTimeline which are greater than or equal to this value will
   * result in a warning message.
   *
   * @const {number}
   */
  static GAP_OVERLAP_TOLERANCE_SECONDS = 1 / 15;

  /**
   * A list of regexps to detect well-known video codecs.
   *
   * @const {!Array.<!RegExp>}
   * @private
   */
  static VIDEO_CODEC_REGEXPS_ = [
    /^avc/,
    /^hev/,
    /^hvc/,
    /^vvc/,
    /^vvi/,
    /^vp0?[89]/,
    /^av01/,
    /^dvh/, // Dolby Vision based in HEVC
    /^dva/, // Dolby Vision based in AVC
    /^dav/, // Dolby Vision based in AV1
  ];

  /**
   * A list of regexps to detect well-known audio codecs.
   *
   * @const {!Array.<!RegExp>}
   * @private
   */
  static AUDIO_CODEC_REGEXPS_ = [
    /^vorbis$/,
    /^Opus$/, // correct codec string according to RFC 6381 section 3.3
    /^opus$/, // some manifests wrongfully use this
    /^fLaC$/, // correct codec string according to RFC 6381 section 3.3
    /^flac$/, // some manifests wrongfully use this
    /^mp4a/,
    /^[ae]c-3$/,
    /^ac-4$/,
    /^dts[cex]$/, // DTS Digital Surround (dtsc), DTS Express (dtse), DTS:X (dtsx)
    /^iamf/,
  ];

  /**
   * A list of regexps to detect well-known text codecs.
   *
   * @const {!Array.<!RegExp>}
   * @private
   */
  static TEXT_CODEC_REGEXPS_ = [/^vtt$/, /^wvtt/, /^stpp/];

  static CODEC_REGEXPS_BY_CONTENT_TYPE_: Record<string, RegExp[]> = {
    audio: ManifestParserUtils.AUDIO_CODEC_REGEXPS_,
    video: ManifestParserUtils.VIDEO_CODEC_REGEXPS_,
    text: ManifestParserUtils.TEXT_CODEC_REGEXPS_,
  };
}
