import { RetryParameters } from '../../externs/shaka/net';
import { Uri } from '../../third_party/closure-uri/uri';
import { ShakaError } from '../util/error';
import { NetworkingEngine, NetworkingEngineRequestType } from './network_engine';

export class NetworkingUtils {
  static async getMimeType(uri: string, netEngine: NetworkingEngine, retryParams: RetryParameters) {
    const extension = NetworkingUtils.getExtension_(uri);
    // @ts-expect-error
    let mimeType = NetworkingUtils.EXTENSIONS_TO_MIME_TYPES_[extension];
    if (mimeType) {
      return mimeType;
    }

    const type = NetworkingEngineRequestType.MANIFEST;
    const request = NetworkingEngine.makeRequest([uri], retryParams);
    try {
      request.method = 'HEAD';
      const response = await netEngine.request(type, request).promise;
      mimeType = response.headers['content-type'];
    } catch (error) {
      if (
        error instanceof ShakaError &&
        (error.code == ShakaError.Code.HTTP_ERROR || error.code == ShakaError.Code.BAD_HTTP_STATUS)
      ) {
        request.method = 'GET';
        const response = await netEngine.request(type, request).promise;
        mimeType = response.headers['content-type'];
      }
    }
    // https://bit.ly/2K9s9kf says this header should always be available,
    // but just to be safe:
    return mimeType ? mimeType.toLowerCase().split(';').shift() : '';
  }

  static getExtension_(uri: string) {
    const uriObj = new Uri(uri);
    const uriPieces = uriObj.getPath().split('/');
    const uriFilename = uriPieces.pop();
    if (!uriFilename) {
      return '';
    }
    const filenamePieces = uriFilename.split('.');

    // Only one piece means there is no extension.
    if (filenamePieces.length == 1) {
      return '';
    }

    return filenamePieces.pop()!.toLowerCase();
  }

  private static EXTENSIONS_TO_MIME_TYPES_ = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    m4a: 'audio/mp4',
    webm: 'video/webm',
    weba: 'audio/webm',
    mkv: 'video/webm', // Chromium browsers supports it.
    ts: 'video/mp2t',
    ogv: 'video/ogg',
    ogg: 'audio/ogg',
    mpg: 'video/mpeg',
    mpeg: 'video/mpeg',
    m3u8: 'application/x-mpegurl',
    mpd: 'application/dash+xml',
    ism: 'application/vnd.ms-sstr+xml',
    mp3: 'audio/mpeg',
    aac: 'audio/aac',
    flac: 'audio/flac',
    wav: 'audio/wav',
    sbv: 'text/x-subviewer',
    srt: 'text/srt',
    vtt: 'text/vtt',
    webvtt: 'text/vtt',
    ttml: 'application/ttml+xml',
    lrc: 'application/x-subtitle-lrc',
    ssa: 'text/x-ssa',
    ass: 'text/x-ssa',
  };
}
