/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CaptionDecoderPlugin,
  CeaParserPlugin,
  ClosedCaption,
} from '../../externs/shaka/cea';
import { DummyCaptionDecoder } from '../cea/dummy_caption_decoder';
import { DummyCeaParser } from '../cea/dummy_cea_parser';
import { BufferUtils } from '../util/buffer_utils';

/**
 * The IClosedCaptionParser defines the interface to provide all operations for
 * parsing the closed captions embedded in Dash videos streams.
 * TODO: Remove this interface and move method definitions
 * directly to ClosedCaptonParser.
 * @interface
 * @export
 */
export interface IClosedCaptionParser {
  /**
   * Initialize the caption parser. This should be called only once.
   * @param {BufferSource} initSegment
   */
  init(initSegment: BufferSource): void;

  /**
   * Parses embedded CEA closed captions and interacts with the underlying
   * CaptionStream, and calls the callback function when there are closed
   * captions.
   *
   * @param {BufferSource} mediaFragment
   * @return {!Array<!shaka.extern.ICaptionDecoder.ClosedCaption>}
   * An array of parsed closed captions.
   */
  parseFrom(mediaFragment: BufferSource): ClosedCaption[];

  /**
   * Resets the CaptionStream.
   */
  reset(): void;

  /**
   * Returns the streams that the CEA decoder found.
   */
  getStreams(): string[];
}

/**
 * Closed Caption Parser provides all operations for parsing the closed captions
 * embedded in Dash videos streams.
 *
 * @implements {shaka.media.IClosedCaptionParser}
 * @final
 * @export
 */
export class ClosedCaptionParser implements IClosedCaptionParser {
  private static parserMap_: Record<string, CeaParserPlugin>;
  private ceaParser_ = new DummyCeaParser();
  private ceaDecoder_ = new DummyCaptionDecoder();
  static decoderFactory_: CaptionDecoderPlugin;
  constructor(mimeType: string) {
    /** @private {!shaka.extern.ICeaParser} */

    const parserFactory = ClosedCaptionParser.findParser(
      mimeType.toLowerCase()
    );
    if (parserFactory) {
      this.ceaParser_ = parserFactory();
    }

    /**
     * Decoder for decoding CEA-X08 data from closed caption packets.
     * @private {!shaka.extern.ICaptionDecoder}
     */

    const decoderFactory = ClosedCaptionParser.findDecoder();
    if (decoderFactory) {
      this.ceaDecoder_ = decoderFactory();
    }
  }

  /**
   * @override
   */
  init(initSegment: BufferSource) {
    this.ceaParser_.init(initSegment);
  }

  /**
   * @override
   */
  parseFrom(mediaFragment: BufferSource) {
    // Parse the fragment.
    const captionPackets = this.ceaParser_.parse(mediaFragment);

    // Extract the caption packets for decoding.
    for (const captionPacket of captionPackets) {
      const uint8ArrayData = BufferUtils.toUint8(captionPacket.packet);
      if (uint8ArrayData.length > 0) {
        this.ceaDecoder_.extract(uint8ArrayData, captionPacket.pts);
      }
    }

    // Decode and return the parsed captions.
    return this.ceaDecoder_.decode();
  }

  /**
   * @override
   */
  reset() {
    this.ceaDecoder_.clear();
  }

  /**
   * @override
   */
  getStreams() {
    return this.ceaDecoder_.getStreams();
  }

  /**
   * @param {string} mimeType
   * @param {!shaka.extern.CeaParserPlugin} plugin
   * @export
   */
  static registerParser(mimeType: string, plugin: CeaParserPlugin) {
    ClosedCaptionParser.parserMap_[mimeType] = plugin;
  }

  /**
   * @param {string} mimeType
   * @export
   */
  static unregisterParser(mimeType: string) {
    delete ClosedCaptionParser.parserMap_[mimeType];
  }

  /**
   * @param {string} mimeType
   * @return {?shaka.extern.CeaParserPlugin}
   * @export
   */
  static findParser(mimeType: string) {
    return ClosedCaptionParser.parserMap_[mimeType];
  }

  /**
   * @param {!shaka.extern.CaptionDecoderPlugin} plugin
   * @export
   */
  static registerDecoder(plugin: CaptionDecoderPlugin) {
    ClosedCaptionParser.decoderFactory_ = plugin;
  }

  /**
   * @export
   */
  static unregisterDecoder() {
    // @ts-expect-error
    ClosedCaptionParser.decoderFactory_ = null;
  }

  /**
   * @return {?shaka.extern.CaptionDecoderPlugin}
   * @export
   */
  static findDecoder() {
    return ClosedCaptionParser.decoderFactory_;
  }
}
