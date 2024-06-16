/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { asserts } from '../debug/asserts';
import { log } from '../debug/log';
import { FakeEvent } from './fake_event';
import { IReleasable } from './i_releasable';
import { MultiMap } from './multi_map';

/**
 * @summary A work-alike for EventTarget.  Only DOM elements may be true
 * EventTargets, but this can be used as a base class to provide event dispatch
 * to non-DOM classes.  Only FakeEvents should be dispatched.
 *
 * @implements {EventTarget}
 * @implements {shaka.util.IReleasable}
 * @exportInterface
 */
export class FakeEventTarget implements IReleasable {
  private listeners_: MultiMap<ListenerType> | null = null;
  dispatchTarget: FakeEventTarget;
  /** */
  constructor() {
    /**
     * @private {shaka.util.MultiMap.<shaka.util.FakeEventTarget.ListenerType>}
     */
    this.listeners_ = new MultiMap();

    this.dispatchTarget = this;
  }

  /**
   * Add an event listener to this object.
   *
   * @param {string} type The event type to listen for.
   * @param listener The callback or
   *   listener object to invoke.
   * @param {(!AddEventListenerOptions|boolean)=} options Ignored.
   * @override
   * @exportInterface
   */
  addEventListener(type: string, listener: ListenerType, options: AddEventListenerOptions | boolean = false) {
    if (!this.listeners_) {
      return;
    }
    this.listeners_.push(type, listener);
  }

  /**
   * Add an event listener to this object that is invoked for all events types
   * the object fires.
   *
   * @param listener The callback or
   *   listener object to invoke.
   * @exportInterface
   */
  listenToAllEvents(listener: ListenerType) {
    this.addEventListener(FakeEventTarget.ALL_EVENTS_, listener);
  }

  /**
   * Remove an event listener from this object.
   *
   * @param {string} type The event type for which you wish to remove a
   *   listener.
   * @param listener The callback or
   *   listener object to remove.
   * @param {(EventListenerOptions|boolean)=} options Ignored.
   * @override
   * @exportInterface
   */
  removeEventListener(type: string, listener: ListenerType, options: EventListenerOptions | boolean = false) {
    if (!this.listeners_) {
      return;
    }
    this.listeners_.remove(type, listener);
  }

  /**
   * Dispatch an event from this object.
   *
   * @param {!Event} event The event to be dispatched from this object.
   * @return {boolean} True if the default action was prevented.
   * @override
   * @exportInterface
   */
  dispatchEvent(event: FakeEvent) {
    // In many browsers, it is complex to overwrite properties of actual Events.
    // Here we expect only to dispatch FakeEvents, which are simpler.
    asserts.assert(event instanceof FakeEvent, 'FakeEventTarget can only dispatch FakeEvents!');

    if (!this.listeners_) {
      return true;
    }

    let listeners = this.listeners_.get(event.type) || [];
    const universalListeners = this.listeners_.get(FakeEventTarget.ALL_EVENTS_);
    if (universalListeners) {
      listeners = listeners.concat(universalListeners);
    }

    // Execute this event on listeners until the event has been stopped or we
    // run out of listeners.
    for (const listener of listeners) {
      // Do this every time, since events can be re-dispatched from handlers.
      event.target = this.dispatchTarget;
      event.currentTarget = this.dispatchTarget;

      try {
        // Check for the |handleEvent| member to test if this is a
        // |EventListener| instance or a basic function.
        if (typeof listener === 'object' && 'handleEvent' in listener) {
          listener.handleEvent(event as any);
        } else {
          // eslint-disable-next-line no-restricted-syntax
          listener.call(this, event);
        }
      } catch (exception: any) {
        // Exceptions during event handlers should not affect the caller,
        // but should appear on the console as uncaught, according to MDN:
        // https://mzl.la/2JXgwRo
        log.error(
          'Uncaught exception in event handler',
          exception,
          exception ? exception.message : null,
          exception ? exception.stack : null
        );
      }

      if (event.stopped) {
        break;
      }
    }

    return event.defaultPrevented;
  }

  /**
   * @override
   * @exportInterface
   */
  release() {
    this.listeners_ = null;
  }

  private static ALL_EVENTS_ = 'All';
}

export type ListenerType = EventListenerObject | ((event: FakeEvent) => any);
