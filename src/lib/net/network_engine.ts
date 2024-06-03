import {
  Request,
  RequestContext,
  Response,
  SchemePlugin,
} from '../../externs/shaka/net';
import { asserts } from '../debug/asserts';
import { ShakaError } from '../util/error';

export class NetworkingEngine {
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
  static registerScheme(
    scheme: string,
    plugin: SchemePlugin,
    priority?: number,
    progressSupport = false
  ) {
    asserts.assert(
      priority == undefined || priority > 0,
      'explicit priority must be > 0'
    );

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
export type NetworkingEngineOnHeadersReceived = (
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
  request: Request
) => void;

/**
 * @typedef {function(
 *    !shaka.extern.Request,
 *    ?shaka.util.Error,
 *    number,
 *    boolean)}
 *
 * @description
 * A callback function that notifies the player when a download fails, for any
 * reason (e.g. even if the download was aborted).
 * @export
 */
export type OnDownloadFailed = (
  request: Request,
  error: ShakaError,
  todo1: number,
  todo2: boolean
) => void;

/**
 *
 * @description
 * A callback function called on every request
 * @export
 */
export type OnRequest = (
  requestType: NetworkingEngineRequestType,
  request: Request,
  context: RequestContext
) => void;

/**
 *
 * @description
 * A callback function called on every request retry. The first string is the
 * new URI and the second string is the old URI.
 * @export
 */
export type OnRetry = (
  reqeustType: NetworkingEngineRequestType,
  context: RequestContext,
  newUrl: string,
  oldUrl: string
) => void;

/**
 * @description
 * A callback function called on every request
 * @export
 */
export type OnResponse = (
  requestType: RequestPriority,
  response: Response,
  context: RequestContext
) => void;
