import { SegmentReference } from '../../lib/media/segment_reference';
import { NetworkingEngineAdvancedRequestType, NetworkingEngineRequestType } from '../../lib/net/network_engine';
import { IAbortableOperation } from './abortable';
import { DrmInfo, Stream } from './manifest';

/**
 * @description
 * Parameters for retrying requests.
 */
export interface RetryParameters {
  // The maximum number of times the request should be attempted.
  maxAttempts: number;
  // The delay before the first retry, in milliseconds.
  baseDelay: number;
  // The multiplier for successive retry delays.
  backoffFactor: number;
  /**
   * The maximum amount of fuzz to apply to each retry delay.
   * For example, 0.5 means "between 50% below and 50% above the retry delay."
   */
  fuzzFactor: number;
  // The request timeout, in milliseconds.  Zero means "unlimited".
  // <i>Defaults to 30000 milliseconds.</i>
  timeout: number;
  /**
   * The request stall timeout, in milliseconds.  Zero means "unlimited".
   * <i>Defaults to 5000 milliseconds.</i>
   */
  stallTimeout: number;
  /**
   * The request connection timeout, in milliseconds.  Zero means "unlimited".
   * <i>Defaults to 10000 milliseconds.</i>
   */
  connectionTimeout: number;
}

type StreamDataCallback = ((source: BufferSource) => Promise<void>) | null;
/**
 * @description
 * Defines a network request.  This is passed to one or more request filters
 * that may alter the request, then it is passed to a scheme plugin which
 * performs the actual operation.
 *
 */
export interface Request {
  /**
   * An array of URIs to attempt.  They will be tried in the order they are
   * given.
   */
  uris: Array<string>;
  /**
   *
   */
  method: string;
  body?: BufferSource;
  headers: Record<string, string>;
  allowCrossSiteCredentials: boolean;
  retryParameters: RetryParameters;
  /**
   * If this is a LICENSE request, this field contains the type of license
   * request it is (not the type of license).  This is the |messageType| field
   * of the EME message.  For example, this could be 'license-request' or
   * 'license-renewal'.
   */
  licenseRequestType?: string;
  /**
   *  If this is a LICENSE request, this field contains the session ID of the
   *  EME session that made the request.
   */
  sessionId?: string;
  /**
   * If this is a LICENSE request, this field contains the DRM info used to
   * initialize EME.
   */
  drmInfo?: DrmInfo;
  /**
   * If this is a LICENSE request, this field contains the initData info used
   * to initialize EME.
   */
  initData?: Uint8Array;
  /**
   * If this is a LICENSE request, this field contains the initDataType info
   * used to initialize EME.
   */
  initDataType?: string;
  //  A callback function to handle the chunked data of the ReadableStream.
  streamDataCallback: StreamDataCallback;
  requestStartTime?: number;
  timeToFirstByte?: number;
  //  A number representing the order the packet within the request.
  packetNumber?: number;
  // Content type (e.g. 'video', 'audio' or 'text', 'image')
  contentType?: string;
}

/**
 * @description
 * A callback function to handle progress event through networking engine in
 * player.
 * The first argument is a number for duration in milliseconds, that the request
 * took to complete.
 * The second argument is the total number of bytes downloaded during that
 * time.
 * The third argument is the number of bytes remaining to be loaded in a
 * segment.
 * @exportDoc
 */
export type ProgressUpdated = (
  duration: number,
  bytesDownloadedDuringThatTime: number,
  remainByteLength: number
) => void;

/**
 *
 * @description
 * A callback function to handle headers received events through networking
 * engine in player.
 * The first argument is the headers object of the response.
 */
export type HeadersReceived = (params: Record<string, string>) => void;

/**
 * @typedef {{
 *   uri: string,
 *   originalUri: string,
 *   data: BufferSource,
 *   status: (number|undefined),
 *   headers: !Object.<string, string>,
 *   timeMs: (number|undefined),
 *   fromCache: (boolean|undefined)
 * }}
 *
 * @description
 * Defines a response object.  This includes the response data and header info.
 * This is given back from the scheme plugin.  This is passed to a response
 * filter before being returned from the request call.
 */

export interface Response {
  /**
   * The URI which was loaded.  Request filters and server redirects can cause
   * this to be different from the original request URIs.
   */
  uri: string;
  /**
   * The original URI passed to the browser for networking. This is before any
   * redirects, but after request filters are executed.
   */
  originalUri: string;
  data: BufferSource;
  status?: number;
  headers: Record<string, string>;
  /**
   * Optional.  The time it took to get the response, in milliseconds.  If not
   * given, NetworkingEngine will calculate it using Date.now.
   */
  timeMs?: number;
  /**
   * Optional. If true, this response was from a cache and should be ignored
   * for bandwidth estimation.
   */
  fromCache?: boolean;
}

/**
 * Defines a plugin that handles a specific scheme.
 *
 * The functions accepts four parameters, uri string, request, request type,
 * a progressUpdated function, and a headersReceived function.  The
 * progressUpdated and headersReceived functions can be ignored by plugins that
 * do not have this information, but it will always be provided by
 * NetworkingEngine.
 *
 * @exportDoc
 */

export type SchemePlugin = (
  todo: string,
  request: Request,
  requestType: NetworkingEngineRequestType,
  onProgressUpdated: ProgressUpdated,
  onHeadersReceived: HeadersReceived
) => IAbortableOperation<Response>;

/**
 * @description
 * Defines contextual data about a request
 */
export interface RequestContext {
  // The advanced type
  type: NetworkingEngineAdvancedRequestType;
  // The duration of the segment in seconds
  stream?: Stream;
  // The request's segment reference
  segment?: SegmentReference;
}

/**
 * Defines a filter for requests.  This filter takes the request and modifies
 * it before it is sent to the scheme plugin.
 * The RequestType describes the basic type of the request (manifest, segment,
 * etc). The optional RequestContext will be provided where applicable to
 * provide additional information about the request. A request filter can run
 * asynchronously by returning a promise; in this case, the request will not be
 * sent until the promise is resolved.
 * @exportDoc
 */
export type RequestFilter = (
  requestType: NetworkingEngineRequestType,
  request: Request,
  requestContext?: RequestContext
) => Promise<any> | void;

/**
 * Defines a filter for responses.  This filter takes the response and modifies
 * it before it is returned.
 * The RequestType describes the basic type of the request (manifest, segment,
 * etc). The optional RequestContext will be provided where applicable to
 * provide additional information about the request. A response filter can run
 * asynchronously by returning a promise.
 * @exportDoc
 */
export type ResponseFilter = (
  reqeust: NetworkingEngineRequestType,
  response: Response,
  reqeustContext?: RequestContext
) => Promise<any> | undefined;
