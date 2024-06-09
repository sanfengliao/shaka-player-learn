/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { asserts } from '../debug/asserts';
import { log } from '../debug/log';
import { Lazy } from './lazy';
import { StringUtils } from './string_utils';

/**
 * @summary A set of XML utility functions.
 */
export class XmlUtils {
  /**
   * Parse a string and return the resulting root element if it was valid XML.
   *
   * @param {string} xmlString
   * @param {string} expectedRootElemName
   * @return {Element}
   */
  static parseXmlString(xmlString: string, expectedRootElemName: string) {
    const parser = new DOMParser();
    const unsafeXmlString = XmlUtils.trustedHTMLFromString_.value()(xmlString);
    let unsafeXml = null;
    try {
      unsafeXml = parser.parseFromString(unsafeXmlString, 'text/xml');
    } catch (exception) {
      log.error('XML parsing exception:', exception);
      return null;
    }

    // According to MDN, parseFromString never returns null.
    asserts.assert(unsafeXml, 'Parsed XML document cannot be null!');

    // Check for empty documents.
    const rootElem = unsafeXml.documentElement;
    if (!rootElem) {
      log.error('XML document was empty!');
      return null;
    }

    // Check for parser errors.
    const parserErrorElements = rootElem.getElementsByTagName('parsererror');
    if (parserErrorElements.length) {
      log.error('XML parser error found:', parserErrorElements[0]);
      return null;
    }

    // The top-level element in the loaded XML should have the name we expect.
    if (rootElem.tagName != expectedRootElemName) {
      log.error(`XML tag name does not match expected "${expectedRootElemName}":`, rootElem.tagName);
      return null;
    }

    // Cobalt browser doesn't support document.createNodeIterator.
    if (!('createNodeIterator' in document)) {
      return rootElem;
    }

    // SECURITY: Verify that the document does not contain elements from the
    // HTML or SVG namespaces, which could trigger script execution and XSS.
    const iterator = document.createNodeIterator(unsafeXml, NodeFilter.SHOW_ALL);
    let currentNode;
    while ((currentNode = iterator.nextNode())) {
      if (currentNode instanceof HTMLElement || currentNode instanceof SVGElement) {
        log.error('XML document embeds unsafe content!');
        return null;
      }
    }

    return rootElem;
  }

  /**
   * Parse some data (auto-detecting the encoding) and return the resulting
   * root element if it was valid XML.
   * @param {BufferSource} data
   * @param {string} expectedRootElemName
   * @return {Element}
   */
  static parseXml(data: BufferSource, expectedRootElemName: string) {
    try {
      const string = StringUtils.fromBytesAutoDetect(data);
      return XmlUtils.parseXmlString(string, expectedRootElemName);
    } catch (exception) {
      log.error('parseXmlString threw!', exception);
      return null;
    }
  }

  /**
   * Converts a Element to BufferSource.
   * @param {!Element} elem
   * @return {!ArrayBuffer}
   */
  static toArrayBuffer(elem: Element) {
    return StringUtils.toUTF8(elem.outerHTML);
  }

  static trustedHTMLFromString_ = new Lazy(() => {
    // if (typeof trustedTypes !== 'undefined') {
    //   // Create a Trusted Types policy for promoting the string to TrustedHTML.
    //   // The Lazy wrapper ensures this policy is only created once.
    //   const policy = trustedTypes.createPolicy('shaka-player#xml', {
    //     createHTML: (s) => s,
    //   });
    //   return (s) => policy.createHTML(s);
    // }
    // Fall back to strings in environments that don't support Trusted Types.
    return (s: string) => s;
  });
}

/**
 * Promote a string to TrustedHTML. This function is security-sensitive and
 * should only be used with security approval where the string is guaranteed not
 * to cause an XSS vulnerability.
 *
 * @private {!shaka.util.Lazy.<function(!string): (!TrustedHTML|!string)>}
 */
