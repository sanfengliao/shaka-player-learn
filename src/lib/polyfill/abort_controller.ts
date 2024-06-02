import { FakeEvent } from '../util/fake_event';
import { FakeEventTarget } from '../util/fake_event_target';
import { polyfill } from './all';

export class AbortController {
  /**
   * Install the polyfill if needed.
   * @export
   */
  static install() {
    if (window.AbortController) {
      // Not needed.
      return;
    }

    // @ts-ignore
    window.AbortController = AbortController;
    // @ts-ignore
    window.AbortSignal = AbortSignal;
  }

  private signal_: AbortSignal;
  constructor() {
    const signal = new AbortSignal();
    this.signal_ = signal;
  }

  get signal() {
    return this.signal_;
  }

  abort(reason?: any) {
    this.signal_.doAbort_(reason);
  }
}

class AbortSignal extends FakeEventTarget {
  private aborted_: boolean = false;
  private reason_: any = undefined;
  onabort: ((event: FakeEvent) => void) | null = null;

  get aborted() {
    return this.aborted_;
  }

  get reason() {
    return this.reason_;
  }

  throwIfAborted() {
    if (this.aborted_) {
      throw this.reason_;
    }
  }

  doAbort_(reason: any) {
    if (this.aborted_) {
      return;
    }

    this.aborted_ = true;
    this.reason_ = reason;
    if (this.reason_ === undefined) {
      // This is equivalent to a native implementation.
      this.reason_ = new DOMException(
        'signal is aborted without reason',
        'AbortError'
      );
    }
    const event = new FakeEvent('abort');
    if (this.onabort) {
      this.onabort(event);
    }

    this.dispatchEvent(event);
  }

  static abort(reason: any) {
    const signal = new AbortSignal();
    signal.doAbort_(reason);
    return signal;
  }

  static timeout(timeMs: number) {
    const signal = new AbortSignal();
    setTimeout(() => {
      signal.doAbort_(new DOMException('timeout', 'AbortError'));
    }, timeMs);
    return signal;
  }
}

polyfill.register(AbortController.install);
