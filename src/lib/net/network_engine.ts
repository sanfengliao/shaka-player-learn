import {
  Request,
  RequestContext,
  RequestFilter,
  Response,
  ResponseFilter,
  RetryParameters,
  SchemePlugin,
} from '../../externs/shaka/net';
import { Uri } from '../../third_party/closure-uri/uri';
import { asserts } from '../debug/asserts';
import { StreamDataCallback } from '../media/segment_prefetch';
import { AbortableOperation } from '../util/abortable_operation';
import { BufferUtils } from '../util/buffer_utils';
import { ShakaError } from '../util/error';
import { FakeEvent } from '../util/fake_event';
import { FakeEventTarget } from '../util/fake_event_target';
import { IDestroyable } from '../util/i_destroyable';
import { ObjectUtils } from '../util/object_utils';
import { OperationManager } from '../util/operation_manager';
import { Timer } from '../util/timer';
import { Backoff } from './backoff';

export class NetworkingEngine extends FakeEventTarget implements IDestroyable {
  private destroyed_ = false;
  private operationManager_ = new OperationManager();
  private requestFilters_: Set<RequestFilter> = new Set();
  private responseFilters_: Set<ResponseFilter> = new Set();
  private onProgressUpdated_: OnProgressUpdated | null = null;
  private onHeadersReceived_: OnHeadersReceived | null = null;
  private onDownloadFailed_: OnDownloadFailed | null = null;
  private onRequest_: OnRequest | null = null;
  private onRetry_: OnRetry | null = null;
  private onResponse_: OnResponse | null = null;
  private forceHTTP_ = false;
  private forceHTTPS_ = false;
  constructor(
    onProgressUpdated: OnProgressUpdated,
    onHeadersReceived: OnHeadersReceived,
    onDownloadFailed: OnDownloadFailed,
    onRequest: OnRequest,
    onRetry: OnRetry,
    onResponse: OnResponse
  ) {
    super();
    this.onProgressUpdated_ = onProgressUpdated || null;
    this.onHeadersReceived_ = onHeadersReceived || null;
    this.onDownloadFailed_ = onDownloadFailed || null;
    this.onRetry_ = onRetry || null;
    this.onResponse_ = onResponse || null;
  }

  setForceHTTP(forceHTTP: boolean) {
    this.forceHTTP_ = forceHTTP;
  }

  setForceHTTPS(forceHTTPS: boolean) {
    this.forceHTTPS_ = forceHTTPS;
  }

  /**
   * Registers a new request filter.  All filters are applied in the order they
   * are registered.
   *
   * @param filter
   * @export
   */
  registerRequestFilter(filter: RequestFilter) {
    this.requestFilters_.add(filter);
  }

  /**
   * Removes a request filter.
   *
   * @param filter
   * @export
   */
  unregisterRequestFilter(filter: RequestFilter) {
    this.requestFilters_.delete(filter);
  }

  /**
   * Clears all request filters.
   *
   * @export
   */
  clearAllRequestFilters() {
    this.requestFilters_.clear();
  }

  /**
   * Registers a new response filter.  All filters are applied in the order they
   * are registered.
   *
   * @param filter
   * @export
   */
  registerResponseFilter(filter: ResponseFilter) {
    this.responseFilters_.add(filter);
  }

  /**
   * Removes a response filter.
   *
   * @param filter
   * @export
   */
  unregisterResponseFilter(filter: ResponseFilter) {
    this.responseFilters_.delete(filter);
  }

  /**
   * Clears all response filters.
   *
   * @export
   */
  clearAllResponseFilters() {
    this.responseFilters_.clear();
  }

  /**
   * Gets a copy of the default retry parameters.
   *
   * NOTE: The implementation moved to shaka.net.Backoff to avoid a circular
   * dependency between the two classes.
   *
   * @export
   */
  static defaultRetryParameters() {
    return Backoff.defaultRetryParameters();
  }

  /**
   * Makes a simple network request for the given URIs.
   *
   * @param  uris
   * @param  retryParams
   * @param  streamDataCallback
   * @return
   * @export
   */
  static makeRequest(
    uris: string[],
    retryParams: RetryParameters,
    streamDataCallback: StreamDataCallback | null = null
  ): Request {
    return {
      uris: uris,
      method: 'GET',
      body: undefined,
      headers: {},
      allowCrossSiteCredentials: false,
      retryParameters: retryParams,
      licenseRequestType: undefined,
      sessionId: undefined,
      drmInfo: undefined,
      initData: undefined,
      initDataType: undefined,
      streamDataCallback: streamDataCallback,
    };
  }
  destroy() {
    this.destroyed_ = true;
    this.requestFilters_.clear();
    this.responseFilters_.clear();

    // FakeEventTarget implements IReleasable
    super.release();

    return this.operationManager_.destroy();
  }

  /**
   * Makes a network request and returns the resulting data.
   *
   */
  request(type: NetworkingEngineRequestType, request: Request, context?: RequestContext): PendingRequest {
    const numBytesRemainingObj = new NumBytesRemainingClass();

    if (this.destroyed_) {
      const p = Promise.reject(
        new ShakaError(ShakaError.Severity.CRITICAL, ShakaError.Category.PLAYER, ShakaError.Code.OPERATION_ABORTED)
      );
      p.catch(() => {});
      return new PendingRequest(p, () => Promise.resolve(), numBytesRemainingObj);
    }

    asserts.assert(request.uris && request.uris.length, 'Request without URIs!');

    // If a request comes from outside the library, some parameters may be left
    // undefined.  To make it easier for application developers, we will fill
    // them in with defaults if necessary.
    //
    // We clone retryParameters and uris so that if a filter modifies the
    // request, it doesn't contaminate future requests.
    request.method = request.method || 'GET';
    request.headers = request.headers || {};
    request.retryParameters = request.retryParameters
      ? ObjectUtils.cloneObject(request.retryParameters)
      : NetworkingEngine.defaultRetryParameters();
    request.uris = ObjectUtils.cloneObject(request.uris);

    // Apply the registered filters to the request.
    const requestFilterOperation = this.filterRequest_(type, request, context);
    const requestOperation = requestFilterOperation.chain(() =>
      this.makeRequestWithRetry_(type, request, context, numBytesRemainingObj)
    );

    const responseFilterOperation = requestOperation.chain((responseAndGotProgress) =>
      this.filterResponse_(type, responseAndGotProgress, context)
    );

    // Keep track of time spent in filters.
    const requestFilterStartTime = Date.now();
    let requestFilterMs = 0;
    requestFilterOperation.promise.then(
      () => {
        requestFilterMs = Date.now() - requestFilterStartTime;
      },
      () => {}
    ); // Silence errors in this fork of the Promise chain.

    let responseFilterStartTime = 0;
    requestOperation.promise.then(
      () => {
        responseFilterStartTime = Date.now();
      },
      () => {}
    ); // Silence errors in this fork of the Promise chain.
    const op = responseFilterOperation.chain(
      (responseAndGotProgress) => {
        const responseFilterMs = Date.now() - responseFilterStartTime;
        const { response } = responseAndGotProgress;
        response.timeMs! += requestFilterMs;
        response.timeMs! += responseFilterMs;
        if (
          !responseAndGotProgress.gotProgress &&
          this.onProgressUpdated_ &&
          !response.fromCache &&
          request.method != 'HEAD' &&
          type == NetworkingEngineRequestType.SEGMENT
        ) {
          const allowSwitch = this.allowSwitch_(context);
          this.onProgressUpdated_(response.timeMs!, response.data.byteLength, allowSwitch, null);
        }
        if (this.onResponse_) {
          this.onResponse_(type, response, context);
        }
        return response;
      },
      (e) => {
        // Any error thrown from elsewhere should be recategorized as CRITICAL
        // here.  This is because by the time it gets here, we've exhausted
        // retries.
        if (e) {
          asserts.assert(e instanceof ShakaError, 'Wrong error type');
          e.severity = ShakaError.Severity.CRITICAL;
        }

        throw e;
      }
    );

    const pendingRequest = new PendingRequest(op.promise, () => op.abort(), numBytesRemainingObj);
    this.operationManager_.manage(pendingRequest);
    return pendingRequest;
  }

  private filterRequest_(type: NetworkingEngineRequestType, request: Request, context?: RequestContext) {
    let filterOperation = AbortableOperation.completed(undefined);
    const applyFilter = (requestFilter: RequestFilter) => {
      filterOperation = filterOperation.chain(() => {
        if (request.body) {
          // TODO: For v4.0 we should remove this or change to always pass a
          // Uint8Array.  To make it easier for apps to write filters, it may be
          // better to always pass a Uint8Array so they know what they are
          // getting; but we shouldn't use ArrayBuffer since that would require
          // copying buffers if this is a partial view.
          request.body = BufferUtils.toArrayBuffer(request.body);
        }
        return requestFilter(type, request, context);
      });
    };

    if (this.onRequest_) {
      applyFilter(this.onRequest_);
    }

    for (const requestFilter of this.requestFilters_) {
      applyFilter(requestFilter);
    }

    return filterOperation.chain(undefined, (e) => {
      if (e instanceof ShakaError && e.code == ShakaError.Code.OPERATION_ABORTED) {
        // Don't change anything if the operation was aborted.
        throw e;
      }

      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.NETWORK,
        ShakaError.Code.REQUEST_FILTER_ERROR,
        e
      );
    });
  }

  /**
   * Copies all of the filters from this networking engine into another.

   */
  copyFiltersInto(other: NetworkingEngine) {
    for (const filter of this.requestFilters_) {
      other.requestFilters_.add(filter);
    }
    for (const filter of this.responseFilters_) {
      other.responseFilters_.add(filter);
    }
  }

  private filterResponse_(
    type: NetworkingEngineRequestType,
    responseAndGotProgress: ResponseAndGotProgress,
    context?: RequestContext
  ) {
    let filterOperation = AbortableOperation.completed(undefined);
    for (const responseFilter of this.responseFilters_) {
      // Response filters are run sequentially.
      filterOperation = filterOperation.chain(() => {
        const resp = responseAndGotProgress.response;
        if (resp.data) {
          // TODO: See TODO in filterRequest_.
          resp.data = BufferUtils.toArrayBuffer(resp.data);
        }
        return responseFilter(type, resp, context);
      });
    }
    // If successful, return the filtered response with whether it got
    // progress.
    return filterOperation.chain(
      () => {
        return responseAndGotProgress;
      },
      (e) => {
        // Catch any errors thrown by request filters, and substitute
        // them with a Shaka-native error.

        // The error is assumed to be critical if the original wasn't a Shaka
        // error.
        let severity = ShakaError.Severity.CRITICAL;
        if (e instanceof ShakaError) {
          if (e.code == ShakaError.Code.OPERATION_ABORTED) {
            // Don't change anything if the operation was aborted.
            throw e;
          }

          severity = e.severity;
        }

        throw new ShakaError(severity, ShakaError.Category.NETWORK, ShakaError.Code.RESPONSE_FILTER_ERROR, e);
      }
    );
  }

  private makeRequestWithRetry_(
    type: NetworkingEngineRequestType,
    request: Request,
    context: RequestContext | undefined,
    numBytesRemainingObj: NumBytesRemainingClass
  ) {
    const backoff = new Backoff(request.retryParameters, false);
    const index = 0;
    return this.send_(type, request, context, backoff, index, null, numBytesRemainingObj);
  }

  private send_(
    type: NetworkingEngineRequestType,
    request: Request,
    context: RequestContext | undefined,
    backoff: Backoff,
    index: number,
    lastError: ShakaError | null,
    numBytesRemainingObj: NumBytesRemainingClass
  ) {
    if (this.forceHTTP_) {
      request.uris[index] = request.uris[index].replace('https://', 'http://');
    }
    if (this.forceHTTPS_) {
      request.uris[index] = request.uris[index].replace('http://', 'https://');
    }

    if (index > 0 && this.onRetry_) {
      const newUri = request.uris[index];
      const oldUri = request.uris[index - 1];
      this.onRetry_(type, context, newUri, oldUri);
    }

    const uri = new Uri(request.uris[index]);

    let scheme = uri.getScheme();

    let gotProgress = false;
    if (!scheme) {
      scheme = NetworkingEngine.getLocationProtocol_();
      asserts.assert(scheme[scheme.length - 1] === ':', 'location.protocol expected to end with a colon!');

      // Remove the colon.
      scheme = scheme.slice(0, -1);

      // Override the original URI to make the scheme explicit.
      uri.setScheme(scheme);
      request.uris[index] = uri.toString();
    }

    // Schemes are meant to be case-insensitive.
    // See https://github.com/shaka-project/shaka-player/issues/2173
    // and https://tools.ietf.org/html/rfc3986#section-3.1
    scheme = scheme.toLowerCase();

    const object = NetworkingEngine.schemes_[scheme];
    const plugin = object ? object.plugin : null;
    if (!plugin) {
      return AbortableOperation.failed(
        new ShakaError(
          ShakaError.Severity.CRITICAL,
          ShakaError.Category.NETWORK,
          ShakaError.Code.UNSUPPORTED_SCHEME,
          uri
        )
      );
    }

    const progressSupport = object.progressSupport;
    const backoffOperation = AbortableOperation.notAbortable(backoff.attempt());

    let connectionTimer: Timer;
    let stallTimer: Timer;

    let aborted = false;

    let headersReceivedCalled = false;

    let startTimeMs: number;

    const sendOperation: AbortableOperation<ResponseAndGotProgress> = backoffOperation
      .chain(() => {
        if (this.destroyed_) {
          return AbortableOperation.aborted();
        }
        startTimeMs = Date.now();

        const segment = NetworkingEngineRequestType.SEGMENT;
        let packetNumber = 0;

        const stallTimeoutMs = request.retryParameters.stallTimeout;
        const connectionTimeoutMs = request.retryParameters.connectionTimeout;

        const progressUpdated = (time: number, bytes: number, numBytesRemaining: number) => {
          if (connectionTimer) {
            connectionTimer.stop();
          }

          if (stallTimer) {
            stallTimer.tickAfter(stallTimeoutMs / 1000);
          }

          if (this.onProgressUpdated_ && type === segment) {
            packetNumber++;
            request.packetNumber = packetNumber;
            const allowSwitch = this.allowSwitch_(context);
            this.onProgressUpdated_(time, bytes, allowSwitch, request);
            gotProgress = true;
            numBytesRemainingObj.setBytes(numBytesRemaining);
          }
        };

        const headersReceived = (header: Record<string, string>) => {
          if (this.onHeadersReceived_) {
            this.onHeadersReceived_(header, request, type);
          }
          headersReceivedCalled = true;
          request.timeToFirstByte = Date.now() - request.requestStartTime!;
        };

        request.requestStartTime = Date.now();

        const requestPlugin = plugin(request.uris[index], request, type, progressUpdated, headersReceived);

        if (!progressSupport) {
          return requestPlugin;
        }

        if (connectionTimeoutMs) {
          connectionTimer = new Timer(() => {
            aborted = true;
            requestPlugin.abort();
          });

          connectionTimer.tickAfter(connectionTimeoutMs / 1000);
        }

        if (stallTimeoutMs) {
          stallTimer = new Timer(() => {
            aborted = true;
            requestPlugin.abort();
          });
        }
        return requestPlugin;
      })
      .chain(
        (response: Response) => {
          if (connectionTimer) {
            connectionTimer.stop();
          }
          if (stallTimer) {
            stallTimer.stop();
          }
          if (response.timeMs === undefined) {
            response.timeMs = Date.now() - startTimeMs;
          }
          const responseAndGotProgress = {
            response: response,
            gotProgress: gotProgress,
          };
          if (!headersReceivedCalled) {
            // The plugin did not call headersReceived, perhaps because it is not
            // able to track that information. So, fire the event manually.
            if (this.onHeadersReceived_) {
              this.onHeadersReceived_(response.headers, request, type);
            }
          }
          return responseAndGotProgress;
        },
        (error: any) => {
          if (connectionTimer) {
            connectionTimer.stop();
          }
          if (stallTimer) {
            stallTimer.stop();
          }

          if (this.onDownloadFailed_) {
            let shakaError: ShakaError | null = null;
            let httpResponseCode = 0;
            if (error instanceof ShakaError) {
              shakaError = error;
              if (error.code === ShakaError.Code.BAD_HTTP_STATUS) {
                httpResponseCode = error.data[1];
              }
            }
            this.onDownloadFailed_(request, shakaError, httpResponseCode, aborted);
          }

          if (this.destroyed_) {
            return AbortableOperation.aborted();
          }

          if (aborted) {
            // It is necessary to change the error code to the correct one because
            // otherwise the retry logic would not work.
            error = new ShakaError(
              ShakaError.Severity.RECOVERABLE,
              ShakaError.Category.NETWORK,
              ShakaError.Code.TIMEOUT,
              request.uris[index],
              type
            );
          }

          if (error instanceof ShakaError) {
            if (error.code == ShakaError.Code.OPERATION_ABORTED) {
              // Don't change anything if the operation was aborted.
              throw error;
            } else if (error.code == ShakaError.Code.ATTEMPTS_EXHAUSTED) {
              asserts.assert(lastError, 'Should have last error');
              throw lastError;
            }

            if (error.severity == ShakaError.Severity.RECOVERABLE) {
              const data = new Map().set('error', error);
              const event = new FakeEvent('retry', data);
              this.dispatchEvent(event);

              // Move to the next URI.
              index = (index + 1) % request.uris.length;
              return this.send_(type, request, context, backoff, index, error, numBytesRemainingObj);
            }
          }

          // The error was not recoverable, so do not try again.
          throw error;
        }
      );

    return sendOperation;
  }

  allowSwitch_(context?: RequestContext) {
    if (context) {
      const segment = context.segment;
      const stream = context.stream;
      if (segment && stream && stream.fastSwitching) {
        if (segment.isPartial()) {
          return false;
        }
      }
    }
    return true;
  }

  private static getLocationProtocol_() {
    return location.protocol;
  }
  /**
   * Contains the scheme plugins.
   *
   */
  private static schemes_: Record<string, NetworkingEngineSchemeObject>;

  /**
   * Registers a scheme plugin.  This plugin will handle all requests with the
   * given scheme.  If a plugin with the same scheme already exists, it is
   * replaced, unless the existing plugin is of higher priority.
   * If no priority is provided, this defaults to the highest priority of
   * APPLICATION.
   *
   */
  static registerScheme(scheme: string, plugin: SchemePlugin, priority?: number, progressSupport = false) {
    asserts.assert(priority == undefined || priority > 0, 'explicit priority must be > 0');

    priority = priority || NetworkingEnginePluginPriority.APPLICATION;
    const existing = NetworkingEngine.schemes_[scheme];
    if (!existing || priority >= existing.priority) {
      NetworkingEngine.schemes_[scheme] = {
        priority,
        plugin,
        progressSupport,
      };
    }
  }

  /**
   * Removes a scheme plugin.
   *
   * @param {string} scheme
   * @export
   */
  static unregisterScheme(scheme: string) {
    delete NetworkingEngine.schemes_[scheme];
  }
}

/**
 * A wrapper class for the number of bytes remaining to be downloaded for the
 * request.
 * Instead of using PendingRequest directly, this class is needed to be sent to
 * plugin as a parameter, and a Promise is returned, before PendingRequest is
 * created.
 *
 * @export
 */

export class NumBytesRemainingClass {
  private bytesToLoad_ = 0;

  /**
   * @param {number} bytesToLoad
   */
  setBytes(bytesToLoad: number) {
    this.bytesToLoad_ = bytesToLoad;
  }

  /**
   * @return {number}
   */
  getBytes() {
    return this.bytesToLoad_;
  }
}

/**
 * A pending network request. This can track the current progress of the
 * download, and allows the request to be aborted if the network is slow.
 *
 * @implements {shaka.extern.IAbortableOperation.<shaka.extern.Response>}
 * @extends {shaka.util.AbortableOperation}
 * @export
 */

export class PendingRequest extends AbortableOperation<Response> {
  bytesRemaining_: NumBytesRemainingClass;
  /**
   * @param  promise
   *   A Promise which represents the underlying operation.  It is resolved
   *   when the operation is complete, and rejected if the operation fails or
   *   is aborted.  Aborted operations should be rejected with a
   *   ShakaError object using the error code OPERATION_ABORTED.
   * @param  onAbort
   *   Will be called by this object to abort the underlying operation.  This
   *   is not cancelation, and will not necessarily result in any work being
   *   undone.  abort() should return a Promise which is resolved when the
   *   underlying operation has been aborted.  The returned Promise should
   *   never be rejected.
   * @param
   *   numBytesRemainingObj
   */
  constructor(promise: Promise<any>, onAbort: () => Promise<any>, numBytesRemainingObj: NumBytesRemainingClass) {
    super(promise, onAbort);

    /** @private {shaka.net.NetworkingEngine.NumBytesRemainingClass} */
    this.bytesRemaining_ = numBytesRemainingObj;
  }

  /**
   * @return {number}
   */
  getBytesRemaining() {
    return this.bytesRemaining_.getBytes();
  }
}

/**
 * Request types.  Allows a filter to decide which requests to read/alter.
 *
 * @enum {number}
 * @export
 */
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

/**
 * A more advanced form of the RequestType structure, meant to describe
 * sub-types of basic request types.
 * For example, an INIT_SEGMENT is a sub-type of SEGMENT.
 * This is meant to allow for more specificity to be added to the request type
 * data, without breaking backwards compatibility.
 *
 * @enum {number}
 * @export
 */
export const enum NetworkingEngineAdvancedRequestType {
  INIT_SEGMENT = 0,
  MEDIA_SEGMENT = 1,
  MEDIA_PLAYLIST = 2,
  MASTER_PLAYLIST = 3,
  MPD = 4,
  MSS = 5,
}

/**
 * Priority level for network scheme plugins.
 * If multiple plugins are provided for the same scheme, only the
 * highest-priority one is used.
 *
 * @enum {number}
 * @export
 */
export const enum NetworkingEnginePluginPriority {
  FALLBACK = 1,
  PREFERRED = 2,
  APPLICATION = 3,
}

export interface NetworkingEngineSchemeObject {
  plugin: SchemePlugin;
  priority: number;
  progressSupport: boolean;
}

/**
 *
 * @description
 * Defines a response wrapper object, including the response object and whether
 * progress event is fired by the scheme plugin.
 */
interface ResponseAndGotProgress {
  response: Response;
  gotProgress: boolean;
}

/**
 * @description
 * A callback function that passes the shaka.extern.HeadersReceived along to
 * the player, plus some extra data.
 * @export
 */
export type OnHeadersReceived = (
  params: Record<string, string>,
  request: Request,
  requestType: NetworkingEngineRequestType
) => void;

/**

 *
 * @description
 * A callback that is passed the duration, in milliseconds,
 * that the request took, the number of bytes transferred, a boolean
 * representing whether the switching is allowed and a ref to the
 * original request.
 * @export
 */
export type OnProgressUpdated = (
  duration: number,
  transferredByteLength: number,
  allowSwitch: boolean,
  request: Request | null
) => void;

/**
 * @typedef {function(
 *    !shaka.extern.Request,
 *    ?ShakaError,
 *    number,
 *    boolean)}
 *
 * @description
 * A callback function that notifies the player when a download fails, for any
 * reason (e.g. even if the download was aborted).
 * @export
 */
export type OnDownloadFailed = (request: Request, error: ShakaError | null, code: number, aborted: boolean) => void;

/**
 *
 * @description
 * A callback function called on every request
 * @export
 */
export type OnRequest = (requestType: NetworkingEngineRequestType, request: Request, context?: RequestContext) => void;

/**
 *
 * @description
 * A callback function called on every request retry. The first string is the
 * new URI and the second string is the old URI.
 * @export
 */
export type OnRetry = (
  reqeustType: NetworkingEngineRequestType,
  context: RequestContext | undefined,
  newUrl: string,
  oldUrl: string
) => void;

/**
 * @description
 * A callback function called on every request
 * @export
 */
export type OnResponse = (
  requestType: NetworkingEngineRequestType,
  response: Response,
  context?: RequestContext
) => void;
