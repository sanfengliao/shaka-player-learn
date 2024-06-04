import {
  HeadersReceived,
  ProgressUpdated,
  Request,
  Response as ShakaResponse,
} from '../../externs/shaka/net';
import { asserts } from '../debug/asserts';
import { log } from '../debug/log';
import { AbortableOperation } from '../util/abortable_operation';
import { ShakaError } from '../util/error';
import { MapUtils } from '../util/map_utils';
import { Timer } from '../util/timer';
import { HttpPluginUtils } from './http_plugin_utils';
import {
  NetworkingEngine,
  NetworkingEnginePluginPriority,
  NetworkingEngineRequestType,
} from './network_engine';

export class HttpFetchPlugin {
  static parse(
    uri: string,
    request: Request,
    requestType: NetworkingEngineRequestType,
    progressUpdated: ProgressUpdated,
    headersReceived: HeadersReceived
  ) {
    const headers = new Headers();
    MapUtils.asMap(request.headers).forEach((value, key) => {
      headers.append(key, value);
    });
    const controller = new AbortController();
    const init: RequestInit = {
      body: request.body,
      headers,
      method: request.method,
      signal: controller.signal,
      credentials: request.allowCrossSiteCredentials ? 'include' : undefined,
    };

    const abortStatus: AbortStatus = { canceled: false, timedOut: false };
    const pendingRequest = HttpFetchPlugin.request_(
      uri,
      requestType,
      init,
      abortStatus,
      progressUpdated,
      headersReceived,
      request.streamDataCallback
    );
    const op = new AbortableOperation(pendingRequest, () => {
      abortStatus.canceled = true;
      controller.abort();
      return Promise.resolve();
    });

    // The fetch API does not timeout natively, so do a timeout manually using
    // the AbortController.
    const timeoutMs = request.retryParameters.timeout;
    if (timeoutMs) {
      const timer = new Timer(() => {
        abortStatus.timedOut = true;
        controller.abort();
      });

      timer.tickAfter(timeoutMs / 1000);

      // To avoid calling |abort| on the network request after it finished, we
      // will stop the timer when the requests resolves/rejects.
      op.finally(() => {
        timer.stop();
      });
    }
    return op;
  }

  private static async request_(
    uri: string,
    requestType: NetworkingEngineRequestType,
    init: RequestInit,
    abortStatus: AbortStatus,
    progressUpdated: ProgressUpdated,
    headersReceived: HeadersReceived,
    streamDataCallback?: (buffer: BufferSource) => Promise<void>
  ): Promise<ShakaResponse> {
    let response: Response;
    let arrayBuffer: BufferSource;
    let loaded = 0;
    let lastLoaded = 0;
    // Last time stamp when we got a progress event.
    let lastTime = Date.now();

    try {
      // The promise returned by fetch resolves as soon as the HTTP response
      // headers are available. The download itself isn't done until the promise
      // for retrieving the data (arrayBuffer, blob, etc) has resolved.
      response = await fetch(uri, init);
      // At this point in the process, we have the headers of the response, but
      // not the body yet.
      headersReceived(
        HttpFetchPlugin.headersToGenericObject_(response.headers)
      );

      // In new versions of Chromium, HEAD requests now have a response body
      // that is null.
      // So just don't try to download the body at all, if it's a HEAD request,
      // to avoid null reference errors.
      // See: https://crbug.com/1297060

      if (init.method !== 'HEAD') {
        asserts.assert(response.body, 'non-HEAD responses should have a body');
        // Getting the reader in this way allows us to observe the process of
        // downloading the body, instead of just waiting for an opaque promise
        // to resolve.
        // We first clone the response because calling getReader locks the body
        // stream; if we didn't clone it here, we would be unable to get the
        // response's arrayBuffer later.
        const reader = response.clone().body!.getReader();
        const contentLengthRaw = response.headers.get('Content-Length');
        const contentLength = contentLengthRaw
          ? parseInt(contentLengthRaw, 10)
          : 0;

        const start = (controller: ReadableStreamDefaultController) => {
          const push = async () => {
            let readObj;
            try {
              readObj = await reader.read();
            } catch (e: any) {
              // If we abort the request, we'll get an error here.  Just ignore
              // it since real errors will be reported when we read the buffer
              // below.
              log.v1('error reading from stream', e.message);
              return;
            }

            if (!readObj.done) {
              loaded += readObj.value.byteLength;
              if (streamDataCallback) {
                await streamDataCallback(readObj.value);
              }
            }
            const currentTime = Date.now();
            // If the time between last time and this time we got progress event
            // is long enough, or if a whole segment is downloaded, call
            // progressUpdated().

            if (currentTime - lastTime > 100 || readObj.done) {
              const numBytesRemaining = readObj.done
                ? 0
                : contentLength - loaded;
              progressUpdated(
                currentTime - lastTime,
                loaded - lastLoaded,
                numBytesRemaining
              );
              lastLoaded = loaded;
              lastTime = currentTime;
            }

            if (readObj.done) {
              asserts.assert(
                !readObj.value,
                'readObj should be unset when "done" is true.'
              );
              controller.close();
            } else {
              controller.enqueue(readObj.value);
              push();
            }
          };

          push();
        };
        new ReadableStream({ start });

        arrayBuffer = await response.arrayBuffer();
      }
    } catch (error) {
      if (abortStatus.canceled) {
        throw new ShakaError(
          ShakaError.Severity.RECOVERABLE,
          ShakaError.Category.NETWORK,
          ShakaError.Code.OPERATION_ABORTED,
          uri,
          requestType
        );
      } else if (abortStatus.timedOut) {
        throw new ShakaError(
          ShakaError.Severity.RECOVERABLE,
          ShakaError.Category.NETWORK,
          ShakaError.Code.TIMEOUT,
          uri,
          requestType
        );
      } else {
        throw new ShakaError(
          ShakaError.Severity.RECOVERABLE,
          ShakaError.Category.NETWORK,
          ShakaError.Code.HTTP_ERROR,
          uri,
          error,
          requestType
        );
      }
    }

    const headers = HttpFetchPlugin.headersToGenericObject_(response.headers);
    return HttpPluginUtils.makeResponse(
      headers,
      // @ts-expect-error
      arrayBuffer,
      response.status,
      uri,
      response.url,
      requestType
    );
  }

  /**
   * @param {!Headers} headers
   * @return {!Object.<string, string>}
   * @private
   */
  static headersToGenericObject_(headers: Headers) {
    const headersObj: Record<string, any> = {};
    headers.forEach((value, key) => {
      // Since Edge incorrectly return the header with a leading new line
      // character ('\n'), we trim the header here.
      headersObj[key.trim()] = value;
    });
    return headersObj;
  }

  /**
   * Determine if the Fetch API is supported in the browser. Note: this is
   * deliberately exposed as a method to allow the client app to use the same
   * logic as Shaka when determining support.
   * @return {boolean}
   * @export
   */
  static isSupported() {
    // On Edge, ReadableStream exists, but attempting to construct it results in
    // an error. See https://bit.ly/2zwaFLL
    // So this has to check that ReadableStream is present AND usable.
    if (window.ReadableStream) {
      try {
        new ReadableStream({}); // eslint-disable-line no-new
      } catch (e) {
        return false;
      }
    } else {
      return false;
    }
    // Old fetch implementations hasn't body and ReadableStream implementation
    // See: https://github.com/shaka-project/shaka-player/issues/5088
    if (window.Response) {
      const response = new Response('');
      if (!response.body) {
        return false;
      }
    } else {
      return false;
    }

    // @ts-expect-error
    return !!(window.fetch && window.AbortController);
  }
}

/**
 * @typedef {{
 *   canceled: boolean,
 *   timedOut: boolean
 * }}
 * @property {boolean} canceled
 *   Indicates if the request was canceled.
 * @property {boolean} timedOut
 *   Indicates if the request timed out.
 */
export interface AbortStatus {
  canceled: boolean;
  timedOut: boolean;
}

if (HttpFetchPlugin.isSupported()) {
  NetworkingEngine.registerScheme(
    'http',
    HttpFetchPlugin.parse,
    NetworkingEnginePluginPriority.PREFERRED,
    /* progressSupport= */ true
  );
  NetworkingEngine.registerScheme(
    'https',
    HttpFetchPlugin.parse,
    NetworkingEnginePluginPriority.PREFERRED,
    /* progressSupport= */ true
  );
  NetworkingEngine.registerScheme(
    'blob',
    HttpFetchPlugin.parse,
    NetworkingEnginePluginPriority.PREFERRED,
    /* progressSupport= */ true
  );
}
