export class NetworkingEngine {}

export const enum NetworkingEngineRequestType {
  MANIFEST = 0,
  SEGMENT = 1,
  LICENSE = 2,
  APP = 3,
  TIMING = 4,
  SERVER_CERTIFICATE = 5,
  KEY = 6,
  ADS = 7,
  CONTENT_STEERING = 8,
}

export const enum NetworkingEngineAdvancedRequestType {
  INIT_SEGMENT = 0,
  MEDIA_SEGMENT = 1,
  MEDIA_PLAYLIST = 2,
  MASTER_PLAYLIST = 3,
  MPD = 4,
  MSS = 5,
}
