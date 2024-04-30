/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Stream } from '../../externs/shaka/manifest';
import { TransmuxerEngine } from '../transmuxer/transmuxer_engine';
import { ManifestParserUtils } from './manifest_parser_utils';

/**
 * @summary A set of utility functions for dealing with MIME types.
 * @export
 */
export class MimeUtils {
  /**
   * Takes a MIME type and optional codecs string and produces the full MIME
   * type. Also remove the codecs for raw formats.
   *
   * @param {string} mimeType
   * @param {string=} codecs
   * @return {string}
   * @export
   */
  static getFullType(mimeType: string, codecs: string = '') {
    let fullMimeType = mimeType;
    if (codecs && !MimeUtils.RAW_FORMATS.includes(mimeType)) {
      fullMimeType += '; codecs="' + codecs + '"';
    }
    return fullMimeType;
  }

  /**
   * Takes a MIME type and optional codecs string and produces the full MIME
   * type.
   *
   * @param {string} mimeType
   * @param {string=} codecs
   * @return {string}
   * @export
   */
  static getFullTypeWithAllCodecs(mimeType: string, codecs: string = '') {
    let fullMimeType = mimeType;
    if (codecs) {
      fullMimeType += '; codecs="' + codecs + '"';
    }
    return fullMimeType;
  }

  /**
   * Takes a MIME type and a codecs string and produces the full MIME
   * type. If it's a transport stream, convert its codecs to MP4 codecs.
   * Otherwise for multiplexed content, convert the video MIME types to
   * their audio equivalents if the content type is audio.
   *
   * @param {string} mimeType
   * @param {string} codecs
   * @param {string} contentType
   * @return {string}
   */
  static getFullOrConvertedType(
    mimeType: string,
    codecs: string,
    contentType: string
  ) {
    const fullMimeType = MimeUtils.getFullType(mimeType, codecs);
    const fullMimeTypeWithAllCodecs = MimeUtils.getFullTypeWithAllCodecs(
      mimeType,
      codecs
    );
    const ContentType = ManifestParserUtils.ContentType;

    if (TransmuxerEngine.isSupported(fullMimeTypeWithAllCodecs, contentType)) {
      return TransmuxerEngine.convertCodecs(
        contentType,
        fullMimeTypeWithAllCodecs
      );
    } else if (mimeType != 'video/mp2t' && contentType == ContentType.AUDIO) {
      // video/mp2t is the correct mime type for TS audio, so only replace the
      // word "video" with "audio" for non-TS audio content.
      return fullMimeType.replace('video', 'audio');
    }
    return fullMimeType;
  }

  /**
   * Takes a Stream object and produces an extended MIME type with information
   * beyond the container and codec type, when available.
   *
   * @param  stream
   * @param {string} mimeType
   * @param {string} codecs
   * @return {string}
   */
  static getExtendedType(stream: Stream, mimeType: string, codecs: string) {
    const components = [mimeType];

    const extendedMimeParams = MimeUtils.EXTENDED_MIME_PARAMETERS_;
    extendedMimeParams.forEach((mimeKey, streamKey) => {
      // @ts-ignore
      const value = stream[streamKey];
      if (streamKey == 'codecs') {
        if (MimeUtils.RAW_FORMATS.includes(stream.mimeType)) {
          // Skip codecs for raw formats
        } else {
          components.push('codecs="' + codecs + '"');
        }
      } else if (value) {
        components.push(mimeKey + '="' + value + '"');
      }
    });
    if (stream.hdr == 'PQ') {
      components.push('eotf="smpte2084"');
    }

    return components.join(';');
  }

  /**
   * Takes a full MIME type (with codecs) or basic MIME type (without codecs)
   * and returns a container type string ("mp2t", "mp4", "webm", etc.)
   *
   * @param {string} mimeType
   * @return {string}
   */
  static getContainerType(mimeType: string) {
    return mimeType.split(';')[0].split('/')[1];
  }

  /**
   * Split a list of codecs encoded in a string into a list of codecs.
   * @param {string} codecs
   * @return {!Array.<string>}
   */
  static splitCodecs(codecs: string) {
    return codecs.split(',');
  }

  /**
   * Get the normalized codec from a codec string,
   * independently of their container.
   *
   * @param {string} codecString
   * @return {string}
   */
  static getNormalizedCodec(codecString: string) {
    const parts = MimeUtils.getCodecParts_(codecString);
    const base = parts[0];
    const profile = parts[1].toLowerCase();
    switch (true) {
      case base === 'mp4a' && profile === '69':
      case base === 'mp4a' && profile === '6b':
      case base === 'mp4a' && profile === '40.34':
        return 'mp3';
      case base === 'mp4a' && profile === '66':
      case base === 'mp4a' && profile === '67':
      case base === 'mp4a' && profile === '68':
      case base === 'mp4a' && profile === '40.2':
      case base === 'mp4a' && profile === '40.02':
      case base === 'mp4a' && profile === '40.5':
      case base === 'mp4a' && profile === '40.05':
      case base === 'mp4a' && profile === '40.29':
      case base === 'mp4a' && profile === '40.42': // Extended HE-AAC
        return 'aac';
      case base === 'mp4a' && profile === 'a5':
        return 'ac-3'; // Dolby Digital
      case base === 'mp4a' && profile === 'a6':
        return 'ec-3'; // Dolby Digital Plus
      case base === 'mp4a' && profile === 'b2':
        return 'dtsx'; // DTS:X
      case base === 'mp4a' && profile === 'a9':
        return 'dtsc'; // DTS Digital Surround
      case base === 'avc1':
      case base === 'avc3':
        return 'avc'; // H264
      case base === 'hvc1':
      case base === 'hev1':
        return 'hevc'; // H265
      case base === 'dvh1':
      case base === 'dvhe':
        return 'dovi'; // Dolby Vision
    }
    return base;
  }

  /**
   * Get the base codec from a codec string.
   *
   * @param {string} codecString
   * @return {string}
   */
  static getCodecBase(codecString: string) {
    const codecsBase = [];
    for (const codec of codecString.split(',')) {
      const parts = MimeUtils.getCodecParts_(codec);
      codecsBase.push(parts[0]);
    }
    return codecsBase.sort().join(',');
  }

  /**
   * Takes a full MIME type (with codecs) or basic MIME type (without codecs)
   * and returns a basic MIME type (without codecs or other parameters).
   *
   * @param {string} mimeType
   * @return {string}
   */
  static getBasicType(mimeType: string) {
    return mimeType.split(';')[0];
  }

  /**
   * Takes a MIME type and returns the codecs parameter, or an empty string if
   * there is no codecs parameter.
   *
   * @param {string} mimeType
   * @return {string}
   */
  static getCodecs(mimeType: string) {
    // Parse the basic MIME type from its parameters.
    const pieces = mimeType.split(/ *; */);
    pieces.shift(); // Remove basic MIME type from pieces.

    const codecs = pieces.find((piece) => piece.startsWith('codecs='));
    if (!codecs) {
      return '';
    }

    // The value may be quoted, so remove quotes at the beginning or end.
    const value = codecs.split('=')[1].replace(/^"|"$/g, '');
    return value;
  }

  /**
   * Checks if the given MIME type is HLS MIME type.
   *
   * @param {string} mimeType
   * @return {boolean}
   */
  static isHlsType(mimeType: string) {
    return (
      mimeType === 'application/x-mpegurl' ||
      mimeType === 'application/vnd.apple.mpegurl'
    );
  }
  /**
   * Get the base and profile of a codec string. Where [0] will be the codec
   * base and [1] will be the profile.
   * @param {string} codecString
   * @return {!Array.<string>}
   * @private
   */
  static getCodecParts_(codecString: string) {
    const parts = codecString.split('.');

    const base = parts[0];

    parts.shift();
    const profile = parts.join('.');

    // Make sure that we always return a "base" and "profile".
    return [base, profile];
  }

  /**
   * A map from Stream object keys to MIME type parameters.  These should be
   * ignored by platforms that do not recognize them.
   *
   * This initial set of parameters are all recognized by Chromecast.
   *
   * @const {!Map.<string, string>}
   * @private
   */
  static EXTENDED_MIME_PARAMETERS_ = new Map()
    .set('codecs', 'codecs')
    .set('frameRate', 'framerate') // Ours is camelCase, theirs is lowercase.
    .set('bandwidth', 'bitrate') // They are in the same units: bits/sec.
    .set('width', 'width')
    .set('height', 'height')
    .set('channelsCount', 'channels');

  /**
   * A mimetype created for CEA-608 closed captions.
   * @const {string}
   */
  static CEA608_CLOSED_CAPTION_MIMETYPE = 'application/cea-608';

  /**
   * A mimetype created for CEA-708 closed captions.
   * @const {string}
   */
  static CEA708_CLOSED_CAPTION_MIMETYPE = 'application/cea-708';

  /**
   * MIME types of raw formats.
   *
   * @const {!Array.<string>}
   */
  static RAW_FORMATS = ['audio/aac', 'audio/ac3', 'audio/ec3', 'audio/mpeg'];
}
