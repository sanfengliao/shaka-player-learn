/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { asserts } from '../debug/asserts';

// TODO: revisit this when Closure Compiler supports partially-exported classes.

export class Dom {
  /**
   * Creates an element, and cast the type from Element to HTMLElement.
   *
   * @param tagName
   */
  static createHTMLElement(tagName: Parameters<typeof document.createElement>[0]) {
    const element = document.createElement(tagName);
    return element;
  }

  /**
   * Create a "button" element with the correct type.
   *
   * The compiler is very picky about the use of the "disabled" property on
   * HTMLElement, since it is only defined on certain subclasses of that.  This
   * method merely creates a button and casts it to the correct type.
   *
   * @return {!HTMLButtonElement}
   */
  static createButton() {
    const button = document.createElement('button');
    button.setAttribute('type', 'button');
    return /** @type {!HTMLButtonElement} */ button;
  }

  /**
   * Cast a Node/Element to an HTMLElement
   *
   * @param original
   */
  static asHTMLElement(original: Node | HTMLElement) {
    return original as HTMLElement;
  }

  /**
   * Cast a Node/Element to an HTMLCanvasElement
   *
   * @param original
   * @return
   */
  static asHTMLCanvasElement(original: Node | HTMLElement) {
    return original as HTMLCanvasElement;
  }

  /**
   * Cast a Node/Element to an HTMLMediaElement
   *
   * @param original
   * @return
   */
  static asHTMLMediaElement(original: Node | Element) {
    return original as HTMLMediaElement;
  }

  /**
   * Returns the element with a given class name.
   * Assumes the class name to be unique for a given parent.
   *
   * @param  className
   * @param  parent
   * @return
   */
  static getElementByClassName(className: string, parent: HTMLElement) {
    const elements = parent.getElementsByClassName(className);
    asserts.assert(elements.length == 1, 'Should only be one element with class name ' + className);

    return Dom.asHTMLElement(elements[0]);
  }

  /**
   * Remove all of the child nodes of an element.
   * @export
   */
  static removeAllChildren(element: Element) {
    while (element.firstChild) {
      element.removeChild(element.firstChild);
    }
  }
}
