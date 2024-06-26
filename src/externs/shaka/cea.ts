/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Cue } from '../../lib/text/cue';

/**
 * @externs
 */

/**
 * Interface for parsing inband closed caption data from MP4 streams.
 * @interface
 * @exportDoc
 */
export interface ICeaParser {
  /**
   * Initializes the parser with init segment data.
   * @param {!BufferSource} initSegment init segment to parse.
   * @exportDoc
   */
  init(initSegment: BufferSource): void;

  /**
   * Parses the stream and extracts closed captions packets.
   * @param {!BufferSource} mediaSegment media segment to parse.
   * @return {!Array<!shaka.extern.ICeaParser.CaptionPacket>}
   * @exportDoc
   */
  parse(mediaSegment: BufferSource): CaptionPacket[];
}

/**
 * @typedef {{
 *   packet: !Uint8Array,
 *   pts: number
 * }}
 *
 * @description Parsed Caption Packet.
 * @property {!Uint8Array} packet
 * Caption packet. More specifically, it contains a "User data
 * registered by Recommendation ITU-T T.35 SEI message", from section D.1.6
 * and section D.2.6 of Rec. ITU-T H.264 (06/2019).
 * @property {number} pts
 * The presentation timestamp (pts) at which the ITU-T T.35 data shows up.
 * in seconds.
 * @exportDoc
 */
export interface CaptionPacket {
  packet: Uint8Array;
  pts: number;
}

/**
 * Interface for decoding inband closed captions from packets.
 * @interface
 * @exportDoc
 */
export interface ICaptionDecoder {
  /**
   * Extracts packets and prepares them for decoding. In a given media fragment,
   * all the caption packets found in its SEI messages should be extracted by
   * successive calls to extract(), followed by a single call to decode().
   *
   * @param userDataSeiMessage
   * This is a User Data registered by Rec.ITU-T T.35 SEI message.
   * It is described in sections D.1.6 and D.2.6 of Rec. ITU-T H.264 (06/2019).
   * @param pts PTS when this packet was received, in seconds.
   * @exportDoc
   */
  extract(userDataSeiMessage: Uint8Array, pts: number): void;

  /**
   * Decodes all currently extracted packets and then clears them.
   * This should be called once for a set of extracts (see comment on extract).
   * @exportDoc
   */
  decode(): ClosedCaption[];

  /**
   * Clears the decoder state completely.
   * Should be used when an action renders the decoder state invalid,
   * e.g. unbuffered seeks.
   * @exportDoc
   */
  clear(): void;

  /**
   * Returns the streams that the CEA decoder found.
   * @return {!Array.<string>}
   * @exportDoc
   */
  getStreams(): string[];
}

export interface ClosedCaption {
  cue: Cue;
  stream: string;
}

export type CeaParserPlugin = () => ICeaParser;

export type CaptionDecoderPlugin = () => ICaptionDecoder;
