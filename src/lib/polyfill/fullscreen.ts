import { polyfill } from './all';

/**
 * @summary A polyfill to unify fullscreen APIs across browsers.
 * Many browsers have prefixed fullscreen methods on Element and document.
 * See {@link https://mzl.la/2K0xcHo Using fullscreen mode} on MDN for more
 * information.
 * @export
 */
export class Fullscreen {
  /**
   * Install the polyfill if needed.
   * @export
   */
  static install() {
    if (!window.Document) {
      // Avoid errors on very old browsers.
      return;
    }

    // eslint-disable-next-line no-restricted-syntax
    let proto = Element.prototype;
    proto.requestFullscreen =
      proto.requestFullscreen ||
      // @ts-ignore
      proto.mozRequestFullScreen ||
      // @ts-ignore
      proto.msRequestFullscreen ||
      // @ts-ignore
      proto.webkitRequestFullscreen;

    // @ts-ignore
    proto = Document.prototype;
    // @ts-ignore
    proto.exitFullscreen =
      // @ts-ignore
      proto.exitFullscreen ||
      // @ts-ignore
      proto.mozCancelFullScreen ||
      // @ts-ignore
      proto.msExitFullscreen ||
      // @ts-ignore
      proto.webkitCancelFullScreen;

    if (!('fullscreenElement' in document)) {
      Object.defineProperty(document, 'fullscreenElement', {
        get: () => {
          return (
            // @ts-ignore
            document.mozFullScreenElement ||
            // @ts-ignore
            document.msFullscreenElement ||
            // @ts-ignore
            document.webkitCurrentFullScreenElement ||
            // @ts-ignore
            document.webkitFullscreenElement
          );
        },
      });
      Object.defineProperty(document, 'fullscreenEnabled', {
        get: () => {
          return (
            // @ts-ignore
            document.mozFullScreenEnabled ||
            // @ts-ignore
            document.msFullscreenEnabled ||
            // @ts-ignore
            document.webkitFullscreenEnabled
          );
        },
      });
    }

    const proxy = Fullscreen.proxyEvent_;
    document.addEventListener('webkitfullscreenchange', proxy);
    document.addEventListener('webkitfullscreenerror', proxy);
    document.addEventListener('mozfullscreenchange', proxy);
    document.addEventListener('mozfullscreenerror', proxy);
    document.addEventListener('MSFullscreenChange', proxy);
    document.addEventListener('MSFullscreenError', proxy);
  }

  /**
   * Proxy fullscreen events after changing their name.
   * @param event
   * @private
   */
  static proxyEvent_(event: Event) {
    const eventType = event.type.replace(/^(webkit|moz|MS)/, '').toLowerCase();

    const newEvent = document.createEvent('Event');
    newEvent.initEvent(eventType, event.bubbles, event.cancelable);

    event.target!.dispatchEvent(newEvent);
  }
}

polyfill.register(Fullscreen.install);
