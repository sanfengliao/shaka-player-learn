/*! @license
 * tXml
 * Copyright 2015 Tobias Nickel
 * SPDX-License-Identifier: MIT
 */

import { XmlNode } from '../../externs/shaka';
import { log } from '../debug/log';
import { StringUtils } from './string_utils';

/**
 * This code is a modified version of the tXml library.
 *
 * @author: Tobias Nickel
 * created: 06.04.2015
 * https://github.com/TobiasNickel/tXml
 */

/**
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
type ChildNode = XmlNode | string;
export class TXml {
  /**
   * Parse some data
   * @param data
   * @param expectedRootElemName

   */
  static parseXml(data: BufferSource, expectedRootElemName: string) {
    const xmlString = StringUtils.fromBytesAutoDetect(data);
    return TXml.parseXmlString(xmlString, expectedRootElemName);
  }

  /**
   * Parse some data
   * @param  xmlString
   * @param  expectedRootElemName
   * @return
   */
  static parseXmlString(xmlString: string, expectedRootElemName: string) {
    const result = TXml.parse(xmlString);
    if (!expectedRootElemName && result.length) {
      return result[0];
    }
    // @ts-expect-error
    const rootNode = result.find((n) => n.tagName === expectedRootElemName);
    if (rootNode) {
      return rootNode;
    }

    log.error('parseXml root element not found!');
    return null;
  }

  /**
   * Parse some data
   * @param {string} schema
   * @return {string}
   */
  static getKnownNameSpace(schema: string) {
    if (TXml.knownNameSpaces_.has(schema)) {
      return TXml.knownNameSpaces_.get(schema);
    }
    return '';
  }

  /**
   * Parse some data
   * @param {string} schema
   * @param {string} NS
   */
  static setKnownNameSpace(schema: string, NS: string) {
    TXml.knownNameSpaces_.set(schema, NS);
  }

  /**
   * parseXML / html into a DOM Object,
   * with no validation and some failure tolerance
   * @param  S your XML to parse
   * @return
   */
  static parse(S: string): ChildNode[] {
    let pos = 0;

    const openBracket = '<';
    const openBracketCC = '<'.charCodeAt(0);
    const closeBracket = '>';
    const closeBracketCC = '>'.charCodeAt(0);
    const minusCC = '-'.charCodeAt(0);
    const slashCC = '/'.charCodeAt(0);
    const exclamationCC = '!'.charCodeAt(0);
    const singleQuoteCC = "'".charCodeAt(0);
    const doubleQuoteCC = '"'.charCodeAt(0);
    const openCornerBracketCC = '['.charCodeAt(0);

    /**
     * parsing a list of entries
     */
    function parseChildren(tagName: string, preserveSpace = false) {
      const children: (XmlNode | string)[] = [];
      while (S[pos]) {
        if (S.charCodeAt(pos) == openBracketCC) {
          if (S.charCodeAt(pos + 1) === slashCC) {
            const closeStart = pos + 2;
            pos = S.indexOf(closeBracket, pos);

            const closeTag = S.substring(closeStart, pos);
            let indexOfCloseTag = closeTag.indexOf(tagName);
            if (indexOfCloseTag == -1) {
              // handle VTT closing tags like <c.lime></c>
              const indexOfPeriod = tagName.indexOf('.');
              if (indexOfPeriod > 0) {
                const shortTag = tagName.substring(0, indexOfPeriod);
                indexOfCloseTag = closeTag.indexOf(shortTag);
              }
            }
            // eslint-disable-next-line no-restricted-syntax
            if (indexOfCloseTag == -1) {
              const parsedText = S.substring(0, pos).split('\n');
              throw new Error(
                'Unexpected close tag\nLine: ' +
                  (parsedText.length - 1) +
                  '\nColumn: ' +
                  (parsedText[parsedText.length - 1].length + 1) +
                  '\nChar: ' +
                  S[pos]
              );
            }

            if (pos + 1) {
              pos += 1;
            }

            return children;
          } else if (S.charCodeAt(pos + 1) === exclamationCC) {
            if (S.charCodeAt(pos + 2) == minusCC) {
              while (
                pos !== -1 &&
                !(
                  S.charCodeAt(pos) === closeBracketCC &&
                  S.charCodeAt(pos - 1) == minusCC &&
                  S.charCodeAt(pos - 2) == minusCC &&
                  pos != -1
                )
              ) {
                pos = S.indexOf(closeBracket, pos + 1);
              }
              if (pos === -1) {
                pos = S.length;
              }
            } else if (
              S.charCodeAt(pos + 2) === openCornerBracketCC &&
              S.charCodeAt(pos + 8) === openCornerBracketCC &&
              S.substr(pos + 3, 5).toLowerCase() === 'cdata'
            ) {
              // cdata
              const cdataEndIndex = S.indexOf(']]>', pos);
              if (cdataEndIndex == -1) {
                children.push(S.substr(pos + 9));
                pos = S.length;
              } else {
                children.push(S.substring(pos + 9, cdataEndIndex));
                pos = cdataEndIndex + 3;
              }
              continue;
            }
            pos++;
            continue;
          }
          const node = parseNode(preserveSpace);
          children.push(node);
          if (typeof node === 'string') {
            return children;
          }
          if (node.tagName[0] === '?' && node.children) {
            children.push(...node.children);
            node.children = [];
          }
        } else {
          const text = parseText();
          if (preserveSpace) {
            if (text.length > 0) {
              children.push(text);
            }
          } else if (children.length && text.length == 1 && text[0] == '\n') {
            children.push(text);
          } else {
            const trimmed = text.trim();
            if (trimmed.length > 0) {
              children.push(text);
            }
          }
          pos++;
        }
      }
      return children;
    }

    /**
     *    returns the text outside of texts until the first '<'
     */
    function parseText() {
      const start = pos;
      pos = S.indexOf(openBracket, pos) - 1;
      if (pos === -2) {
        pos = S.length;
      }
      return S.slice(start, pos + 1);
    }
    /**
     *    returns text until the first nonAlphabetic letter
     */
    const nameSpacer = '\r\n\t>/= ';

    /**
     * Parse text in current context
     * @return {string}
     */
    function parseName() {
      const start = pos;
      while (nameSpacer.indexOf(S[pos]) === -1 && S[pos]) {
        pos++;
      }
      return S.slice(start, pos);
    }

    /**
     * Parse text in current context
     * @param preserveSpace Preserve the space between nodes
     * @return
     */
    function parseNode(preserveSpace: boolean): XmlNode | string {
      pos++;
      const tagName = parseName();
      const attributes: Record<string, string | null> = {};
      let children: ChildNode[] = [];

      // parsing attributes
      while (S.charCodeAt(pos) !== closeBracketCC && S[pos]) {
        const c = S.charCodeAt(pos);
        // abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
        if ((c > 64 && c < 91) || (c > 96 && c < 123)) {
          const name = parseName();
          // search beginning of the string
          let code = S.charCodeAt(pos);
          while (
            code &&
            code !== singleQuoteCC &&
            code !== doubleQuoteCC &&
            !((code > 64 && code < 91) || (code > 96 && code < 123)) &&
            code !== closeBracketCC
          ) {
            pos++;
            code = S.charCodeAt(pos);
          }
          let value: string | null = parseString();
          if (code === singleQuoteCC || code === doubleQuoteCC) {
            if (pos === -1) {
              /** @type {shaka.extern.xml.Node} */
              const node = {
                tagName,
                attributes,
                children,
                parent: null,
              };
              for (let i = 0; i < children.length; i++) {
                if (typeof children[i] !== 'string') {
                  (children[i] as XmlNode).parent = node;
                }
              }
              return node;
            }
          } else {
            value = null;
            pos--;
          }
          if (name.startsWith('xmlns:')) {
            const segs = name.split(':');
            TXml.setKnownNameSpace(value as string, segs[1]);
          }
          if (tagName === 'tt' && name === 'xml:space' && value === 'preserve') {
            preserveSpace = true;
          }
          attributes[name] = value;
        }
        pos++;
      }

      if (S.charCodeAt(pos - 1) !== slashCC) {
        pos++;
        const contents = parseChildren(tagName, preserveSpace);
        children = contents;
      } else {
        pos++;
      }
      /** @type {shaka.extern.xml.Node} */
      const node = {
        tagName,
        attributes,
        children,
        parent: null,
      };
      const childrenLength = children.length;
      for (let i = 0; i < childrenLength; i++) {
        const childrenValue = children[i];
        if (typeof childrenValue !== 'string') {
          childrenValue.parent = node;
        } else if (i == childrenLength - 1 && childrenValue == '\n') {
          children.pop();
        }
      }
      return node;
    }

    /**
     * Parse string in current context
     * @return {string}
     */
    function parseString() {
      const startChar = S[pos];
      const startpos = pos + 1;
      pos = S.indexOf(startChar, startpos);
      return S.slice(startpos, pos);
    }

    return parseChildren('');
  }

  /**
   * Verifies if the element is a TXml node.
   * @param elem The XML element.
   * @return  Is the element a TXml node
   */
  static isNode(elem: XmlNode) {
    return !!elem.tagName;
  }

  /**
   * Checks if a node is of type text.
   * @param elem The XML element.
   * @return True if it is a text node.
   */
  static isText(elem: ChildNode) {
    return typeof elem === 'string';
  }

  /**
   * gets child XML elements.
   * @param  elem The parent XML element.
   * @return The child XML elements.
   */
  static getChildNodes(elem: XmlNode) {
    const found = [];
    if (!elem.children) {
      return [];
    }
    for (const child of elem.children) {
      if (typeof child !== 'string') {
        found.push(child);
      }
    }
    return found;
  }

  /**
   * Finds child XML elements.
   * @param  elem The parent XML element.
   * @param name The child XML element's tag name.
   * @return The child XML elements.
   */
  static findChildren(elem: XmlNode, name: string) {
    const found = [];
    if (!elem.children) {
      return [];
    }
    for (const child of elem.children) {
      // @ts-expect-error
      if (child.tagName === name) {
        found.push(child);
      }
    }
    return found;
  }

  /**
   * Gets inner text.
   * @param {!shaka.extern.xml.Node | string} node The XML element.
   * @return {?string} The text contents, or null if there are none.
   */
  static getTextContents(node: ChildNode) {
    if (typeof node === 'string') {
      return StringUtils.htmlUnescape(node);
    }
    const textContent = node.children.reduce((acc, curr) => (typeof curr === 'string' ? acc + curr : acc), '');
    if (textContent === '') {
      return null;
    }
    return StringUtils.htmlUnescape(textContent as string);
  }

  /**
   * Gets the text contents of a node.
   * @param {!shaka.extern.xml.Node} node The XML element.
   * @return {?string} The text contents, or null if there are none.
   */
  static getContents(node: XmlNode) {
    if (!Array.from(node.children).every((n) => typeof n === 'string')) {
      return null;
    }

    // Read merged text content from all text nodes.
    let text = TXml.getTextContents(node);
    if (text) {
      text = text.trim();
    }
    return text;
  }

  /**
   * Finds child XML elements recursively.
   * @param {!shaka.extern.xml.Node} elem The parent XML element.
   * @param {string} name The child XML element's tag name.
   * @param {!Array.<!shaka.extern.xml.Node>} found accumulator for found nodes
   * @return {!Array.<!shaka.extern.xml.Node>} The child XML elements.
   */
  static getElementsByTagName(elem: XmlNode, name: string, found: XmlNode[] = []) {
    if (elem.tagName === name) {
      found.push(elem);
    }
    if (elem.children) {
      for (const child of elem.children) {
        TXml.getElementsByTagName(child as XmlNode, name, found);
      }
    }
    return found;
  }

  /**
   * Finds a child XML element.
   * @param {!shaka.extern.xml.Node} elem The parent XML element.
   * @param {string} name The child XML element's tag name.
   * @return {shaka.extern.xml.Node | null} The child XML element,
   *   or null if a child XML element
   *   does not exist with the given tag name OR if there exists more than one
   *   child XML element with the given tag name.
   */
  static findChild(elem: XmlNode, name: string) {
    const children = TXml.findChildren(elem, name);
    if (children.length != 1) {
      return null;
    }
    return children[0];
  }

  /**
   * Finds a namespace-qualified child XML element.
   * @param {!shaka.extern.xml.Node} elem The parent XML element.
   * @param {string} ns The child XML element's namespace URI.
   * @param {string} name The child XML element's local name.
   * @return {shaka.extern.xml.Node | null} The child XML element, or null
   *   if a child XML element
   *   does not exist with the given tag name OR if there exists more than one
   *   child XML element with the given tag name.
   */
  static findChildNS(elem: XmlNode, ns: string, name: string): XmlNode | null {
    const children = TXml.findChildrenNS(elem, ns, name);
    if (children.length != 1) {
      return null;
    }
    return children[0] as any;
  }

  /**
   * Parses an attribute by its name.
   * @param {!shaka.extern.xml.Node} elem The XML element.
   * @param {string} name The attribute name.
   * @param {function(string): (T|null)} parseFunction A function that parses
   *   the attribute.
   * @param {(T|null)=} defaultValue The attribute's default value, if not
   *   specified, the attibute's default value is null.
   * @return {(T|null)} The parsed attribute on success, or the attribute's
   *   default value if the attribute does not exist or could not be parsed.
   * @template T
   */
  static parseAttr<T>(elem: XmlNode, name: string, parseFunction: (value: string) => T | null, defaultValue = null) {
    let parsedValue = null;

    const value = elem.attributes[name];
    if (value != null) {
      parsedValue = parseFunction(value);
    }
    return parsedValue == null ? defaultValue : parsedValue;
  }

  /**
   * Gets a namespace-qualified attribute.
   * @param {!shaka.extern.xml.Node} elem The element to get from.
   * @param {string} ns The namespace URI.
   * @param {string} name The local name of the attribute.
   * @return {?string} The attribute's value, or null if not present.
   */
  static getAttributeNS(elem: XmlNode, ns: string, name: string) {
    const schemaNS = TXml.getKnownNameSpace(ns);
    // Think this is equivalent
    const attribute = elem.attributes[`${schemaNS}:${name}`];
    return attribute || null;
  }

  /**
   * Finds namespace-qualified child XML elements.
   * @param {!shaka.extern.xml.Node} elem The parent XML element.
   * @param {string} ns The child XML element's namespace URI.
   * @param {string} name The child XML element's local name.
   * @return {!Array.<!shaka.extern.xml.Node>} The child XML elements.
   */
  static findChildrenNS(elem: XmlNode, ns: string, name: string) {
    const schemaNS = TXml.getKnownNameSpace(ns);
    const found = [];
    if (elem.children) {
      for (const child of elem.children) {
        // @ts-expect-error
        if (child && child.tagName === `${schemaNS}:${name}`) {
          found.push(child);
        }
      }
    }
    return found;
  }

  /**
   * Gets a namespace-qualified attribute.
   * @param {!shaka.extern.xml.Node} elem The element to get from.
   * @param {!Array.<string>} nsList The lis of namespace URIs.
   * @param {string} name The local name of the attribute.
   * @return {?string} The attribute's value, or null if not present.
   */
  static getAttributeNSList(elem: XmlNode, nsList: string[], name: string) {
    for (const ns of nsList) {
      const attr = TXml.getAttributeNS(elem, ns, name);
      if (attr) {
        return attr;
      }
    }
    return null;
  }

  /**
   * Parses an XML date string.
   * @param {string} dateString
   * @return {?number} The parsed date in seconds on success; otherwise, return
   *   null.
   */
  static parseDate(dateString: string) {
    if (!dateString) {
      return null;
    }

    // Times in the manifest should be in UTC. If they don't specify a timezone,
    // Date.parse() will use the local timezone instead of UTC.  So manually add
    // the timezone if missing ('Z' indicates the UTC timezone).
    // Format: YYYY-MM-DDThh:mm:ss.ssssss
    if (/^\d+-\d+-\d+T\d+:\d+:\d+(\.\d+)?$/.test(dateString)) {
      dateString += 'Z';
    }

    const result = Date.parse(dateString);
    return isNaN(result) ? null : result / 1000.0;
  }

  /**
   * Parses an XML duration string.
   * Negative values are not supported. Years and months are treated as exactly
   * 365 and 30 days respectively.
   * @param {string} durationString The duration string, e.g., "PT1H3M43.2S",
   *   which means 1 hour, 3 minutes, and 43.2 seconds.
   * @return {?number} The parsed duration in seconds on success; otherwise,
   *   return null.
   * @see {@link http://www.datypic.com/sc/xsd/t-xsd_duration.html}
   */
  static parseDuration(durationString: string) {
    if (!durationString) {
      return null;
    }

    const re = '^P(?:([0-9]*)Y)?(?:([0-9]*)M)?(?:([0-9]*)D)?' + '(?:T(?:([0-9]*)H)?(?:([0-9]*)M)?(?:([0-9.]*)S)?)?$';
    const matches = new RegExp(re).exec(durationString);

    if (!matches) {
      log.warning('Invalid duration string:', durationString);
      return null;
    }

    // Note: Number(null) == 0 but Number(undefined) == NaN.
    const years = Number(matches[1] || null);
    const months = Number(matches[2] || null);
    const days = Number(matches[3] || null);
    const hours = Number(matches[4] || null);
    const minutes = Number(matches[5] || null);
    const seconds = Number(matches[6] || null);

    // Assume a year always has 365 days and a month always has 30 days.
    const d =
      60 * 60 * 24 * 365 * years +
      60 * 60 * 24 * 30 * months +
      60 * 60 * 24 * days +
      60 * 60 * hours +
      60 * minutes +
      seconds;
    return isFinite(d) ? d : null;
  }

  /**
   * Parses a range string.
   * @param {string} rangeString The range string, e.g., "101-9213".
   * @return {?{start: number, end: number}} The parsed range on success;
   *   otherwise, return null.
   */
  static parseRange(rangeString: string) {
    const matches = /([0-9]+)-([0-9]+)/.exec(rangeString);

    if (!matches) {
      return null;
    }

    const start = Number(matches[1]);
    if (!isFinite(start)) {
      return null;
    }

    const end = Number(matches[2]);
    if (!isFinite(end)) {
      return null;
    }

    return { start: start, end: end };
  }

  /**
   * Parses an integer.
   * @param {string} intString The integer string.
   * @return {?number} The parsed integer on success; otherwise, return null.
   */
  static parseInt(intString: string) {
    const n = Number(intString);
    return n % 1 === 0 ? n : null;
  }

  /**
   * Parses a positive integer.
   * @param {string} intString The integer string.
   * @return {?number} The parsed positive integer on success; otherwise,
   *   return null.
   */
  static parsePositiveInt(intString: string) {
    const n = Number(intString);
    return n % 1 === 0 && n > 0 ? n : null;
  }

  /**
   * Parses a non-negative integer.
   * @param {string} intString The integer string.
   * @return {?number} The parsed non-negative integer on success; otherwise,
   *   return null.
   */
  static parseNonNegativeInt(intString: string) {
    const n = Number(intString);
    return n % 1 === 0 && n >= 0 ? n : null;
  }

  /**
   * Parses a floating point number.
   * @param {string} floatString The floating point number string.
   * @return {?number} The parsed floating point number on success; otherwise,
   *   return null. May return -Infinity or Infinity.
   */
  static parseFloat(floatString: string) {
    const n = Number(floatString);
    return !isNaN(n) ? n : null;
  }

  /**
   * Parses a boolean.
   * @param {string} booleanString The boolean string.
   * @return {boolean} The boolean
   */
  static parseBoolean(booleanString: string) {
    if (!booleanString) {
      return false;
    }
    return booleanString.toLowerCase() === 'true';
  }

  /**
   * Evaluate a division expressed as a string.
   * @param {string} exprString
   *   The expression to evaluate, e.g. "200/2". Can also be a single number.
   * @return {?number} The evaluated expression as floating point number on
   *   success; otherwise return null.
   */
  static evalDivision(exprString: string) {
    let res;
    let n;
    if ((res = exprString.match(/^(\d+)\/(\d+)$/))) {
      n = Number(res[1]) / Number(res[2]);
    } else {
      n = Number(exprString);
    }
    return !isNaN(n) ? n : null;
  }

  /**
   * Parse xPath strings for segments and id targets.
   * @param {string} exprString
   * @return
   */
  static parseXpath(exprString: string): TXmlPathNode[] {
    const returnPaths: TXmlPathNode[] = [];
    // Split string by paths but ignore '/' in quotes
    const paths = StringUtils.htmlUnescape(exprString).split(/\/+(?=(?:[^'"]*['"][^'"]*['"])*[^'"]*$)/);
    for (const path of paths) {
      const nodeName = path.match(/^([\w]+)/);

      if (nodeName) {
        // We only want the id attribute in which case
        // /'(.*?)'/ will suffice to get it.
        const idAttr = path.match(/(@id='(.*?)')/);
        const position = path.match(/\[(\d+)\]/);
        returnPaths.push({
          name: nodeName[0],
          // @ts-expect-error
          id: idAttr ? idAttr[0].match(/'(.*?)'/)[0].replace(/'/gm, '') : null,
          // position is counted from 1, so make it readable for devs
          position: position ? Number(position[1]) - 1 : null,
          attribute: path.split('/@')[1] || null,
        });
      } else if (path.startsWith('@') && returnPaths.length) {
        returnPaths[returnPaths.length - 1].attribute = path.slice(1);
      }
    }

    return returnPaths;
  }

  /**
   * Modifies nodes in specified array by adding or removing nodes
   * and updating attributes.
   * @param  nodes
   * @param  patchNode
   */
  static modifyNodes(nodes: XmlNode, patchNode: XmlNode) {
    const paths = TXml.parseXpath(patchNode.attributes['sel'] || '');
    if (!paths.length) {
      return;
    }
    const lastNode = paths[paths.length - 1];
    const position = patchNode.attributes['pos'] || null;

    let index = lastNode.position!;
    if (index === null) {
      // @ts-expect-error
      index = position === 'prepend' ? 0 : nodes.length;
    } else if (position === 'prepend') {
      --index;
    } else if (position === 'after') {
      ++index;
    }
    const action = patchNode.tagName;
    const attribute = lastNode.attribute;

    // Modify attribute
    if (attribute) {
      // @ts-expect-error
      TXml.modifyNodeAttribute(nodes[index], action, attribute, TXml.getContents(patchNode) || '');
      // Rearrange nodes
    } else {
      if (action === 'remove' || action === 'replace') {
        // @ts-expect-error
        nodes.splice(index, 1);
      }
      if (action === 'add' || action === 'replace') {
        const newNodes = patchNode.children;
        // @ts-expect-error
        nodes.splice(index, 0, ...newNodes);
      }
    }
  }

  /**
   * @param {!shaka.extern.xml.Node} node
   * @param {string} action
   * @param {string} attribute
   * @param {string} value
   */
  static modifyNodeAttribute(node: XmlNode, action: string, attribute: string, value: string) {
    if (action === 'remove') {
      delete node.attributes[attribute];
    } else if (action === 'add' || action === 'replace') {
      node.attributes[attribute] = value;
    }
  }

  /**
   * Converts a tXml node to DOM element.
   * @param {shaka.extern.xml.Node} node
   * @param {boolean=} doParents
   * @param {boolean=} doChildren
   * @return {!Element}
   */
  static txmlNodeToDomElement(node: XmlNode, doParents = true, doChildren = true) {
    const element = document.createElement(node.tagName);

    for (const k in node.attributes) {
      const v = node.attributes[k];
      element.setAttribute(k, v);
    }

    if (doParents && node.parent && node.parent.tagName != '?xml') {
      const parentElement = TXml.txmlNodeToDomElement(node.parent, /* doParents= */ true, /* doChildren= */ false);
      parentElement.appendChild(element);
    }

    if (doChildren) {
      for (const child of node.children) {
        let childElement;
        if (typeof child == 'string') {
          childElement = new Text(child);
        } else {
          childElement = TXml.txmlNodeToDomElement(child, /* doParents= */ false, /* doChildren= */ true);
        }
        element.appendChild(childElement);
      }
    }

    return element;
  }

  static knownNameSpaces_ = new Map([]);
}

interface TXmlPathNode {
  name: string;
  id?: string;
  position?: number | null;
  attribute?: string | null;
}
