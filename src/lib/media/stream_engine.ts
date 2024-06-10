import { Stream } from '../../externs/shaka/manifest';
import { RetryParameters } from '../../externs/shaka/net';
import { log } from '../debug/log';
import {
  NetworkingEngine,
  NetworkingEngineAdvancedRequestType,
  NetworkingEngineRequestType,
} from '../net/network_engine';
import { IDestroyable } from '../util/i_destroyable';
import { Networking } from '../util/networking';
import { StreamDataCallback } from './segment_prefetch';
import { InitSegmentReference, SegmentReference } from './segment_reference';

/**
 * @summary Creates a Streaming Engine.
 * The StreamingEngine is responsible for setting up the Manifest's Streams
 * (i.e., for calling each Stream's createSegmentIndex() function), for
 * downloading segments, for co-ordinating audio, video, and text buffering.
 * The StreamingEngine provides an interface to switch between Streams, but it
 * does not choose which Streams to switch to.
 *
 * The StreamingEngine does not need to be notified about changes to the
 * Manifest's SegmentIndexes; however, it does need to be notified when new
 * Variants are added to the Manifest.
 *
 * To start the StreamingEngine the owner must first call configure(), followed
 * by one call to switchVariant(), one optional call to switchTextStream(), and
 * finally a call to start().  After start() resolves, switch*() can be used
 * freely.
 *
 * The owner must call seeked() each time the playhead moves to a new location
 * within the presentation timeline; however, the owner may forego calling
 * seeked() when the playhead moves outside the presentation timeline.
 *
 */
export class StreamingEngine implements IDestroyable {
  destroy(): Promise<void> {
    throw new Error('Method not implemented.');
  }
  static dispatchFetch(
    reference: InitSegmentReference | SegmentReference,
    stream: Stream,
    streamDataCallback: StreamDataCallback,
    retryParameters: RetryParameters,
    netEngine: NetworkingEngine
  ) {
    const requestType = NetworkingEngineRequestType.SEGMENT;
    const segment = reference instanceof SegmentReference ? reference : undefined;
    const type = segment
      ? NetworkingEngineAdvancedRequestType.MEDIA_SEGMENT
      : NetworkingEngineAdvancedRequestType.INIT_SEGMENT;
    const request = Networking.createSegmentRequest(
      reference.getUris(),
      reference.startByte,
      reference.endByte,
      retryParameters,
      streamDataCallback
    );

    request.contentType = stream.type;

    log.v2('fetching: reference=', reference);

    return netEngine.request(requestType, request, { type, stream, segment });
  }
}