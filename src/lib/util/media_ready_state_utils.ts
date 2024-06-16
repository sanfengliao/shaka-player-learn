/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventManager } from './event_manager';

export class MediaReadyState {
  static waitForReadyState(
    mediaElement: HTMLMediaElement,
    readyState: number,
    eventManager: EventManager,
    callback: Function
  ) {
    if (readyState == HTMLMediaElement.HAVE_NOTHING || mediaElement.readyState >= readyState) {
      callback();
    } else {
      const eventName = MediaReadyState.READY_STATES_TO_EVENT_NAMES_.get(readyState as any);
      eventManager.listenOnce(mediaElement, eventName as any, callback as EventListener);
    }
  }

  private static READY_STATES_TO_EVENT_NAMES_ = new Map([
    [HTMLMediaElement.HAVE_METADATA, 'loadedmetadata'],
    [HTMLMediaElement.HAVE_CURRENT_DATA, 'loadeddata'],
    [HTMLMediaElement.HAVE_FUTURE_DATA, 'canplay'],
    [HTMLMediaElement.HAVE_ENOUGH_DATA, 'canplaythrough'],
  ]);
}
