/*! @license
 * Shaka Player
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface MPEG_PES {
  data: Uint8Array;
  packetLength: number;
  pts: number | null;
  dts: number | null;
  nalus: VideoNalu[];
}

export interface VideoNalu {
  data: Uint8Array;
  fullData: Uint8Array;
  type: number;
  time: number | null;
}

export interface SpatialVideoInfo {
  projection: string | null;
  hfov: number | null;
}
