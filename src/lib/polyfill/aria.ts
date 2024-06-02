import { log } from '../debug/log';
import { polyfill } from './all';

class Aria {
  static install() {
    if (Object.getOwnPropertyDescriptor(Element.prototype, 'ariaHidden')) {
      log.info('Using native ARIAMixin interface.');
      return;
    }
    log.info('ARIAMixin interface not detected. Installing polyfill.');

    // Define a list of all of the ARIAMixin properties that we have externs
    // for.
    const attributes = [
      'ariaHidden',
      'ariaLabel',
      'ariaPressed',
      'ariaSelected',
    ];

    // Add each attribute, one by one.
    for (const attribute of attributes) {
      Aria.addARIAMixinAttribute_(attribute);
    }
  }
  static addARIAMixinAttribute_(name: string) {
    const baseName = name.toLowerCase().replace(/^aria/, '');
    // NOTE: All the attributes listed in the method above begin with "aria".
    // However, to add extra protection against the possibility of XSS attacks
    // through this method, this enforces "aria-" at the beginning of the
    // snake-case name, even if somehow "aria" were missing from the input.
    const snakeCaseName = `aria-${baseName}`;

    /* eslint-disable no-restricted-syntax */
    Object.defineProperty(Element.prototype, name, {
      get() {
        const element: Element = this;
        return element.getAttribute(snakeCaseName);
      },
      set(value) {
        const element: Element = this;
        if (value == null || value == undefined) {
          element.removeAttribute(snakeCaseName);
        } else {
          element.setAttribute(snakeCaseName, value);
        }
      },
    });
  }
}

polyfill.register(Aria.install);
