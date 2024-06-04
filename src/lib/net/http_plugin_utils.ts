/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Response } from '../../externs/shaka/net';
import { log } from '../debug/log';
import { ShakaError } from '../util/error';
import { StringUtils } from '../util/string_utils';
import { NetworkingEngineRequestType } from './network_engine';

/**
 * @summary A set of http networking utility functions.
 * @exportDoc
 */
export class HttpPluginUtils {
  /**
   * @param headers
   * @param data
   * @param status
   * @param uri
   * @param responseURL
   * @param requestType
   * @return
   */
  static makeResponse(
    headers: Record<string, string>,
    data: BufferSource,
    status: number,
    uri: string,
    responseURL: string,
    requestType: NetworkingEngineRequestType
  ): Response {
    if (status >= 200 && status <= 299 && status != 202) {
      const response: Response = {
        uri: responseURL || uri,
        originalUri: uri,
        data: data,
        status: status,
        headers: headers,
        fromCache: !!headers['x-shaka-from-cache'],
      };
      return response;
    } else {
      let responseText = null;
      try {
        responseText = StringUtils.fromBytesAutoDetect(data);
      } catch (exception) {}
      log.debug('HTTP error text:', responseText);

      const severity =
        status == 401 || status == 403
          ? ShakaError.Severity.CRITICAL
          : ShakaError.Severity.RECOVERABLE;

      throw new ShakaError(
        severity,
        ShakaError.Category.NETWORK,
        ShakaError.Code.BAD_HTTP_STATUS,
        uri,
        status,
        responseText,
        headers,
        requestType,
        responseURL || uri
      );
    }
  }
}
