/**
 * @summary A networking plugin to handle data URIs.
 * @see https://developer.mozilla.org/en-US/docs/Web/HTTP/data_URIs
 * @export
 */

import { IAbortableOperation } from '../../externs/shaka/abortable';
import { ProgressUpdated, Request, Response } from '../../externs/shaka/net';
import { log } from '../debug/log';
import { AbortableOperation } from '../util/abortable_operation';
import { ShakaError } from '../util/error';
import { StringUtils } from '../util/string_utils';
import { Uint8ArrayUtils } from '../util/uint8array_utils';
import { NetworkingEngine, NetworkingEngineRequestType } from './network_engine';

export class DataUriPlugin {
  /**
   * @param  uri
   * @param  request
   * @param  requestType
   * @param  progressUpdated Called when a
   *   progress event happened.
   * @return
   * @export
   */
  static parse(
    uri: string,
    request: Request,
    requestType: NetworkingEngineRequestType,
    progressUpdated: ProgressUpdated
  ): IAbortableOperation<Response> {
    try {
      const parsed = DataUriPlugin.parseRaw(uri);
      const reponse: Response = {
        uri,
        originalUri: uri,
        data: parsed.data,
        headers: {
          'content-type': parsed.contentType,
        },
      };
      return AbortableOperation.completed(reponse);
    } catch (error: any) {
      return AbortableOperation.failed(error);
    }
  }

  static parseRaw(uri: string) {
    // Extract the scheme.
    const parts = uri.split(':');
    if (parts.length < 2 || parts[0] != 'data') {
      log.error('Bad data URI, failed to parse scheme');
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.NETWORK,
        ShakaError.Code.MALFORMED_DATA_URI,
        uri
      );
    }
    const path = parts.slice(1).join(':');

    // Extract the encoding and MIME type (required but can be empty).
    const infoAndData = path.split(',');
    if (infoAndData.length < 2) {
      log.error('Bad data URI, failed to extract encoding and MIME type');
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.NETWORK,
        ShakaError.Code.MALFORMED_DATA_URI,
        uri
      );
    }
    const info = infoAndData[0];
    const dataStr = window.decodeURIComponent(infoAndData.slice(1).join(','));

    // The MIME type is always the first thing in the semicolon-separated list
    // of type parameters.  It may be blank.
    const typeInfoList = info.split(';');
    const contentType = typeInfoList[0];

    // Check for base64 encoding, which is always the last in the
    // semicolon-separated list if present.
    let base64Encoded = false;
    if (typeInfoList.length > 1 && typeInfoList[typeInfoList.length - 1] == 'base64') {
      base64Encoded = true;
      typeInfoList.pop();
    }

    // Convert the data.
    /** @type {BufferSource} */
    let data;
    if (base64Encoded) {
      data = Uint8ArrayUtils.fromBase64(dataStr);
    } else {
      data = StringUtils.toUTF8(dataStr);
    }

    return { data: data, contentType };
  }
}

NetworkingEngine.registerScheme('data', DataUriPlugin.parse);
