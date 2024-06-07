import { ManifestParserFactory } from '../../externs/shaka/manifest_parser';
import { Deprecate } from '../deprecate/deprecate';
import { Platform } from '../util/platform';

export class ManifestParser {
  static UNKNOWN = 'UNKNOWN';
  static HLS = 'HLS';
  static DASH = 'DASH';
  static MSS = 'MSS';
  static parsersByMime: Record<string, ManifestParserFactory> = {};

  /**
   * Registers a manifest parser by file extension.
   *
   * @param extension The file extension of the manifest.
   * @param parserFactory The factory
   *   used to create parser instances.
   * @export
   */
  static registerParserByExtension(extension: string, parserFactory: ManifestParserFactory) {
    Deprecate.deprecateFeature(
      5,
      'ManifestParser.registerParserByExtension',
      'Please use an ManifestParser with registerParserByMime function.'
    );
  }

  /**
   * Registers a manifest parser by MIME type.
   *
   * @param mimeType The MIME type of the manifest.
   * @param parserFactory The factory
   *   used to create parser instances.
   * @export
   */
  static registerParserByMime(mimeType: string, parserFactory: ManifestParserFactory) {
    ManifestParser.parsersByMime[mimeType] = parserFactory;
  }

  /**
   * Unregisters a manifest parser by MIME type.
   *
   * @param {string} mimeType The MIME type of the manifest.
   * @export
   */
  static unregisterParserByMime(mimeType: string) {
    delete ManifestParser.parsersByMime[mimeType];
  }

  /**
   * Returns a map of manifest support for well-known types.
   *
   */
  static probeSupport() {
    const support: Record<string, boolean> = {};

    // Make sure all registered parsers are shown, but only for MSE-enabled
    // platforms where our parsers matter.
    if (Platform.supportsMediaSource()) {
      for (const type in ManifestParser.parsersByMime) {
        support[type] = true;
      }
    }

    // Make sure all well-known types are tested as well, just to show an
    // explicit false for things people might be expecting.
    const testMimeTypes = [
      // DASH
      'application/dash+xml',
      // HLS
      'application/x-mpegurl',
      'application/vnd.apple.mpegurl',
      // SmoothStreaming
      'application/vnd.ms-sstr+xml',
    ];

    for (const type of testMimeTypes) {
      // Only query our parsers for MSE-enabled platforms.  Otherwise, query a
      // temporary media element for native support for these types.
      if (Platform.supportsMediaSource()) {
        support[type] = !!ManifestParser.parsersByMime[type];
      } else {
        support[type] = Platform.supportsMediaType(type);
      }
    }

    return support;
  }
}

export const enum AccessibilityPurpose {
  VISUALLY_IMPAIRED = 'visually impaired',
  HARD_OF_HEARING = 'hard of hearing',
}
