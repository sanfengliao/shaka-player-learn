/**
 * @summary
 * An EventManager maintains a collection of "event
 * bindings" between event targets and event listeners.
 *
 * @implements {shaka.util.IReleasable}
 * @export
 */

import { asserts } from '../debug/asserts';
import { IReleasable } from './i_releasable';
import { MultiMap } from './multi_map';

type GetEventKey<T> = T extends {
  addEventListener(
    type: infer K,
    listener: (this: any, ev: any) => any,
    options?: boolean | AddEventListenerOptions
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): void;
}
  ? K
  : never;

export class EventManager<T extends EventTarget> implements IReleasable {
  bindingMap_: MultiMap<Binding_<T>> | null = new MultiMap();
  release(): void {
    this.removeAll();
    this.bindingMap_ = null;
  }

  /**
   * Attaches an event listener to an event target.
   * @param target The event target.
   * @param type The event type.
   * @param listener The event listener.
   * @param options An object that
   *    specifies characteristics about the event listener.
   *    The passive option, if true, indicates that this function will never
   *    call preventDefault(), which improves scrolling performance.
   * @export
   */
  listen(target: T, type: GetEventKey<T>, listener: EventListener, options?: boolean | AddEventListenerOptions) {
    if (!this.bindingMap_) {
      return;
    }
    this.bindingMap_.push(type as any, new Binding_(target, type, listener, options));
  }

  /**
   * Attaches an event listener to an event target.  The listener will be
   * removed when the first instance of the event is fired.
   * @param target The event target.
   * @param type The event type.
   * @param listener The event listener.
   * @param options An object that
   *    specifies characteristics about the event listener.
   *    The passive option, if true, indicates that this function will never
   *    call preventDefault(), which improves scrolling performance.
   * @export
   */
  listenOnce(target: T, type: GetEventKey<T>, listener: EventListener, options?: boolean | AddEventListenerOptions) {
    if (!this.bindingMap_) {
      return;
    }
    const slim = (event: Event) => {
      this.unlisten(target, type, slim);
      listener(event);
    };
    this.listen(target, type, slim, options);
  }

  /**
   * Detaches an event listener from an event target.
   * @param target The event target.
   * @param type The event type.
   * @param listener The event listener.
   * @export
   */

  unlisten(target: T, type: GetEventKey<T>, listener?: EventListener) {
    if (!this.bindingMap_) {
      return;
    }
    const list = this.bindingMap_.get(type) || [];
    for (const binding of list) {
      if (binding.target === target) {
        if (listener === binding.listener || !listener) {
          binding.unlisten();
          this.bindingMap_.remove(type, binding);
        }
      }
    }
  }
  /**
   * Detaches all event listeners from all targets.
   * @export
   */
  removeAll() {
    if (!this.bindingMap_) {
      return;
    }

    const list = this.bindingMap_.getAll();

    for (const binding of list) {
      binding.unlisten();
    }

    this.bindingMap_.clear();
  }
}

class Binding_<T extends EventTarget> {
  target: T | null = null;
  type: GetEventKey<T>;
  listener: EventListener | null = null;
  options: boolean | AddEventListenerOptions;

  constructor(target: T, type: GetEventKey<T>, listener: EventListener, options?: boolean | AddEventListenerOptions) {
    this.target = target;
    this.type = type;
    this.listener = listener;
    this.options = Binding_.convertOptions_(target, options);
    this.target.addEventListener(this.type as any, this.listener, this.options);
  }
  /**
   * Detaches the event listener from the event target. This does nothing if
   * the event listener is already detached.
   */
  unlisten() {
    asserts.assert(this.target, 'Missing target');
    this.target!.removeEventListener(this.type as any, this.listener, this.options);

    this.target = null;
    this.listener = null;
    this.options = false;
  }
  private static convertOptions_(
    target: EventTarget,
    value?: boolean | AddEventListenerOptions
  ): boolean | AddEventListenerOptions {
    if (value === undefined) {
      return false;
    }

    if (typeof value === 'boolean') {
      return value;
    }

    // Ignore the 'passive' option since it is just an optimization and
    // doesn't affect behavior.  Assert there aren't any other settings to
    // ensure we don't have different behavior on different browsers by
    // ignoring an important option.
    const ignored = new Set(['passive', 'capture']);
    const keys = Object.keys(value).filter((k) => !ignored.has(k));
    asserts.assert(keys.length == 0, 'Unsupported flag(s) to addEventListener: ' + keys.join(','));
    const supports = Binding_.doesSupportObject_(target);
    if (supports) {
      return value;
    } else {
      return value['capture'] || false;
    }
  }

  /**
   * Checks whether the browser supports passing objects as the third argument
   * to addEventListener.  This caches the result value in a static field to
   * avoid a bunch of checks.
   *
   * @param {EventTarget} target
   * @return {boolean}
   * @private
   */
  static doesSupportObject_(target: EventTarget) {
    // https://developer.mozilla.org/en-US/docs/Web/API/EventTarget/addEventListener#Safely_detecting_option_support
    let supports = Binding_.supportsObject_;
    if (supports == undefined) {
      supports = false;
      try {
        const options = {};
        const prop = {
          get() {
            supports = true;
            return false;
          },
        };
        Object.defineProperty(options, 'passive', prop);
        Object.defineProperty(options, 'capture', prop);

        const call = () => {};
        target.addEventListener('test', call, options);
        target.removeEventListener('test', call, options);
      } catch (e) {
        supports = false;
      }
      Binding_.supportsObject_ = supports;
    }

    return supports || false;
  }

  static supportsObject_: boolean | undefined = undefined;
}
