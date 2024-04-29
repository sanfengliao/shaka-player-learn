import { DrmInfo } from "./manifest";
/**
 * @typedef {{
*   maxAttempts: number,
*   baseDelay: number,
*   backoffFactor: number,
*   fuzzFactor: number,
*   timeout: number,
*   stallTimeout: number,
*   connectionTimeout: number
* }}
*
* @description
*   Parameters for retrying requests.
*
* @property {number} maxAttempts
*   The maximum number of times the request should be attempted.
* @property {number} baseDelay
*   The delay before the first retry, in milliseconds.
* @property {number} backoffFactor
*   The multiplier for successive retry delays.
* @property {number} fuzzFactor
*   The maximum amount of fuzz to apply to each retry delay.
*   For example, 0.5 means "between 50% below and 50% above the retry delay."
* @property {number} timeout
*   The request timeout, in milliseconds.  Zero means "unlimited".
*   <i>Defaults to 30000 milliseconds.</i>
* @property {number} stallTimeout
*   The request stall timeout, in milliseconds.  Zero means "unlimited".
*   <i>Defaults to 5000 milliseconds.</i>
* @property {number} connectionTimeout
*   The request connection timeout, in milliseconds.  Zero means "unlimited".
*   <i>Defaults to 10000 milliseconds.</i>
*
* @tutorial network-and-buffering-config
*
* @exportDoc
*/
export interface RetryParameters {
  maxAttempts: number;
  baseDelay: number;
  backoffFactor: number;
  fuzzFactor: number;
  timeout: number;
  stallTimeout: number;
  connectionTimeout: number;
}


/**
 * @typedef {{
*   uris: !Array.<string>,
*   method: string,
*   body: ?BufferSource,
*   headers: !Object.<string, string>,
*   allowCrossSiteCredentials: boolean,
*   retryParameters: !shaka.extern.RetryParameters,
*   licenseRequestType: ?string,
*   sessionId: ?string,
*   drmInfo: ?shaka.extern.DrmInfo,
*   initData: ?Uint8Array,
*   initDataType: ?string,
*   streamDataCallback: ?function(BufferSource):!Promise,
*   requestStartTime: (?number|undefined),
*   timeToFirstByte: (?number|undefined),
*   packetNumber: (?number|undefined),
*   contentType: (?string|undefined)
* }}
*
* @description
* Defines a network request.  This is passed to one or more request filters
* that may alter the request, then it is passed to a scheme plugin which
* performs the actual operation.
*
* @property {!Array.<string>} uris
*   An array of URIs to attempt.  They will be tried in the order they are
*   given.
* @property {string} method
*   The HTTP method to use for the request.
* @property {?BufferSource} body
*   The body of the request.
* @property {!Object.<string, string>} headers
*   A mapping of headers for the request.  e.g.: {'HEADER': 'VALUE'}
* @property {boolean} allowCrossSiteCredentials
*   Make requests with credentials.  This will allow cookies in cross-site
*   requests.  See {@link https://bit.ly/CorsCred}.
* @property {!shaka.extern.RetryParameters} retryParameters
*   An object used to define how often to make retries.
* @property {?string} licenseRequestType
*   If this is a LICENSE request, this field contains the type of license
*   request it is (not the type of license).  This is the |messageType| field
*   of the EME message.  For example, this could be 'license-request' or
*   'license-renewal'.
* @property {?string} sessionId
*   If this is a LICENSE request, this field contains the session ID of the
*   EME session that made the request.
* @property {?shaka.extern.DrmInfo} drmInfo
*   If this is a LICENSE request, this field contains the DRM info used to
*   initialize EME.
* @property {?Uint8Array} initData
*   If this is a LICENSE request, this field contains the initData info used
*   to initialize EME.
* @property {?string} initDataType
*   If this is a LICENSE request, this field contains the initDataType info
*   used to initialize EME.
* @property {?function(BufferSource):!Promise} streamDataCallback
*   A callback function to handle the chunked data of the ReadableStream.
* @property {(?number|undefined)} requestStartTime
*   The time that the request started.
* @property {(?number|undefined)} timeToFirstByte
*   The time taken to the first byte.
* @property {(?number|undefined)} packetNumber
*   A number representing the order the packet within the request.
* @property {(?string|undefined)} contentType
*   Content type (e.g. 'video', 'audio' or 'text', 'image')
* @exportDoc
*/
export interface Request {
  uris: Array<string>;
  method: string;
  body?: BufferSource;
  headers: Record<string, string>;
  allowCrossSiteCredentials: boolean;
  retryParameters: RetryParameters;
  licenseRequestType?: string;
  sessionId?: string;
  drmInfo?: DrmInfo;
  initData?: Uint8Array;
  initDataType?: string;
  streamDataCallback?: ((source: BufferSource) => Promise<void>);
  requestStartTime?: number;
  timeToFirstByte?: number;
  packetNumber?: number;
  contentType?: string;
}