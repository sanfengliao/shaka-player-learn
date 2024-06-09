import { log } from '../debug/log';
import { ManifestParserUtils } from '../util/manifest_parser_utils';
import { MimeUtils } from '../util/mime_utils';
import { Capabilities } from './media_source_capabilities';

export class SegmentUtils {
  /**
   * @param codecs
   * @return
   */
  static codecsFiltering(codecs: string[]) {
    const ContentType = ManifestParserUtils.ContentType;

    const allCodecs = SegmentUtils.filterDuplicateCodecs_(codecs);
    const audioCodecs = ManifestParserUtils.guessAllCodecsSafe(ContentType.AUDIO, allCodecs);
    const videoCodecs = ManifestParserUtils.guessAllCodecsSafe(ContentType.VIDEO, allCodecs);
    const textCodecs = ManifestParserUtils.guessAllCodecsSafe(ContentType.TEXT, allCodecs);
    const validVideoCodecs = SegmentUtils.chooseBetterCodecs_(videoCodecs);
    const finalCodecs = audioCodecs.concat(validVideoCodecs).concat(textCodecs);
    if (allCodecs.length && !finalCodecs.length) {
      return allCodecs;
    }
    return finalCodecs;
  }

  /**
   *
   * @param {!Array.<string>} codecs
   * @return {!Array.<string>} codecs
   * @private
   */
  static filterDuplicateCodecs_(codecs: string[]) {
    // Filter out duplicate codecs.
    const seen = new Set();
    const ret = [];
    for (const codec of codecs) {
      const shortCodec = MimeUtils.getCodecBase(codec);
      if (!seen.has(shortCodec)) {
        ret.push(codec);
        seen.add(shortCodec);
      } else {
        log.debug('Ignoring duplicate codec');
      }
    }
    return ret;
  }

  /**
   * Prioritizes Dolby Vision if supported. This is necessary because with
   * Dolby Vision we could have hvcC and dvcC boxes at the same time.
   *
   * @param codecs
   * @return codecs
   * @private
   */
  static chooseBetterCodecs_(codecs: string[]) {
    if (codecs.length <= 1) {
      return codecs;
    }
    const dolbyVision = codecs.find((codec) => {
      return codec.startsWith('dvh1.') || codec.startsWith('dvhe.') || codec.startsWith('dav1.');
    });
    if (!dolbyVision) {
      return codecs;
    }
    const type = `video/mp4; codecs="${dolbyVision}"`;
    if (Capabilities.isTypeSupported(type)) {
      return [dolbyVision];
    }
    return codecs.filter((codec) => codec != dolbyVision);
  }
}
