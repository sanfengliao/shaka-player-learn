import { IAbortableOperation } from '../../externs/shaka/abortable';
import {
  HeadersReceived,
  ProgressUpdated,
  Request,
  Response,
} from '../../externs/shaka/net';
import { asserts } from '../debug/asserts';
import { AbortableOperation } from '../util/abortable_operation';
import { ShakaError } from '../util/error';
import { HttpPluginUtils } from './http_plugin_utils';
import {
  NetworkingEngine,
  NetworkingEnginePluginPriority,
  NetworkingEngineRequestType,
} from './network_engine';

export class HttpXHRPlugin {
  static parse(
    uri: string,
    request: Request,
    requestType: NetworkingEngineRequestType,
    progressUpdated: ProgressUpdated,
    headersReceived: HeadersReceived
  ): IAbortableOperation<Response> {
    const xhr = new XMLHttpRequest();

    let lastTime = Date.now();
    let lastLoaded = 0;

    const promise = new Promise<Response>((resolve, reject) => {
      xhr.open(request.method, uri, true);
      xhr.responseType = 'arraybuffer';
      xhr.timeout = request.retryParameters.timeout;
      xhr.withCredentials = request.allowCrossSiteCredentials;

      xhr.onabort = () => {
        reject(
          new ShakaError(
            ShakaError.Severity.RECOVERABLE,
            ShakaError.Category.NETWORK,
            ShakaError.Code.OPERATION_ABORTED,
            uri,
            requestType
          )
        );
      };

      let calledHeadersReceived = false;

      xhr.onreadystatechange = () => {
        if (xhr.readyState == 2 && !calledHeadersReceived) {
          calledHeadersReceived = true;
          headersReceived(HttpXHRPlugin.headersToGenericObject_(xhr));
        }
      };

      xhr.onload = (event) => {
        const headers = HttpXHRPlugin.headersToGenericObject_(xhr);
        asserts.assert(
          xhr.response instanceof ArrayBuffer,
          'XHR should have a response by now!'
        );
        try {
          const currentTime = Date.now();

          progressUpdated(currentTime - lastTime, event.loaded - lastLoaded, 0);
          resolve(
            HttpPluginUtils.makeResponse(
              headers,
              xhr.response,
              xhr.status,
              uri,
              xhr.responseURL,
              requestType
            )
          );
        } catch (error) {
          asserts.assert(error instanceof ShakaError, 'Wrong error type!');
          reject(error);
        }
      };

      xhr.onerror = (event) => {
        reject(
          new ShakaError(
            ShakaError.Severity.RECOVERABLE,
            ShakaError.Category.NETWORK,
            ShakaError.Code.HTTP_ERROR,
            uri,
            event,
            requestType
          )
        );
      };

      xhr.ontimeout = (event) => {
        reject(
          new ShakaError(
            ShakaError.Severity.RECOVERABLE,
            ShakaError.Category.NETWORK,
            ShakaError.Code.TIMEOUT,
            uri,
            requestType
          )
        );
      };

      xhr.onprogress = (event) => {
        const currentTime = Date.now();
        // If the time between last time and this time we got progress event
        // is long enough, or if a whole segment is downloaded, call
        // progressUpdated().

        if (
          currentTime - lastTime > 100 ||
          (event.lengthComputable && event.loaded === event.total)
        ) {
          const numBytesRemaining =
            xhr.readyState === 4 ? 0 : event.total - event.loaded;
          progressUpdated(
            currentTime - lastTime,
            event.loaded - lastLoaded,
            numBytesRemaining
          );
          lastLoaded = event.loaded;
          lastTime = currentTime;
        }
      };

      for (const key in request.headers) {
        xhr.setRequestHeader(key.toLowerCase(), request.headers[key]);
      }
      xhr.send(request.body);
    });

    return new AbortableOperation(promise, () => {
      xhr.abort();
      return Promise.resolve();
    });
  }

  /**
   * @param
   * @return
   * @private
   */
  static headersToGenericObject_(xhr: XMLHttpRequest) {
    // Since Edge incorrectly return the header with a leading new
    // line character ('\n'), we trim the header here.
    const headerLines = xhr.getAllResponseHeaders().trim().split('\r\n');
    const headers: Record<string, any> = {};
    for (const header of headerLines) {
      /** @type {!Array.<string>} */
      const parts = header.split(': ');
      headers[parts[0].toLowerCase()] = parts.slice(1).join(': ');
    }
    return headers;
  }
}

NetworkingEngine.registerScheme(
  'http',
  HttpXHRPlugin.parse,
  NetworkingEnginePluginPriority.FALLBACK,
  /* progressSupport= */ true
);
NetworkingEngine.registerScheme(
  'https',
  HttpXHRPlugin.parse,
  NetworkingEnginePluginPriority.FALLBACK,
  /* progressSupport= */ true
);
NetworkingEngine.registerScheme(
  'blob',
  HttpXHRPlugin.parse,
  NetworkingEnginePluginPriority.FALLBACK,
  /* progressSupport= */ true
);
