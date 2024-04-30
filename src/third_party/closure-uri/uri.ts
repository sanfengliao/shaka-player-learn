/**
 * This class contains setters and getters for the parts of the URI.
 * The <code>getXyz</code>/<code>setXyz</code> methods return the decoded part
 * -- so<code>new goog.Uri('/foo%20bar').getPath()</code> will return the
 * decoded path, <code>/foo bar</code>.
 *
 * Reserved characters (see RFC 3986 section 2.2) can be present in
 * their percent-encoded form in scheme, domain, and path URI components and
 * will not be auto-decoded. For example:
 * <code>new goog.Uri('rel%61tive/path%2fto/resource').getPath()</code> will
 * return <code>relative/path%2fto/resource</code>.
 *
 * The constructor accepts an optional unparsed, raw URI string.  The parser
 * is relaxed, so special characters that aren't escaped but don't cause
 * ambiguities will not cause parse failures.
 *
 * All setters return <code>this</code> and so may be chained, a la
 * <code>new goog.Uri('/foo').setFragment('part').toString()</code>.
 *
 */

import { utils } from './utils';

export class Uri {
  /**
   * Scheme such as "http".
   * @type {string}
   * @private
   */
  private scheme_ = '';
  /**
   * User credentials in the form "username:password".
   * @type {string}
   * @private
   */
  private userInfo_ = '';
  /**
   * Domain part, e.g. "www.google.com".
   * @type {string}
   * @private
   */
  private domain_ = '';

  /**
   * Port, e.g. 8080.
   * @type {?number}
   * @private
   */
  private port_: number | null = null;
  /**
   * Path, e.g. "/tests/img.png".
   * @type {string}
   * @private
   */
  private path_ = '';
  /**
   * Object representing query data.
   * @private
   */
  private queryData_!: QueryData;

  /**
   * The fragment without the #.
   * @type {string}
   * @private
   */
  private fragment_ = '';

  constructor(uri?: string | Uri) {
    let m: RegExpMatchArray | null;
    if (uri instanceof Uri) {
      this.setScheme(uri.getScheme());
      this.setUserInfo(uri.getUserInfo());
      this.setDomain(uri.getDomain());
      this.setPort(uri.getPort());
      this.setPath(uri.getPath());
      this.setQueryData(uri.getQueryData().clone());
      this.setFragment(uri.getFragment());
    } else if (uri && (m = utils.split(String(uri)))) {
      this.setScheme(m[utils.ComponentIndex.SCHEME] || '', true);
      this.setUserInfo(m[utils.ComponentIndex.USER_INFO] || '', true);
      this.setDomain(m[utils.ComponentIndex.DOMAIN] || '', true);
      this.setPort(Number(m[utils.ComponentIndex.PORT]));
      this.setPath(m[utils.ComponentIndex.PATH] || '', true);
      this.setQueryData(m[utils.ComponentIndex.QUERY_DATA] || '', true);
      this.setFragment(m[utils.ComponentIndex.FRAGMENT] || '', true);
    } else {
      this.queryData_ = new QueryData(null);
    }
  }

  /**
   * @return {string} The string form of the url.
   * @override
   */
  toString() {
    var out = [];

    var scheme = this.getScheme();
    if (scheme) {
      out.push(
        Uri.encodeSpecialChars_(
          scheme,
          Uri.reDisallowedInSchemeOrUserInfo_,
          true
        ),
        ':'
      );
    }

    var domain = this.getDomain();
    if (domain) {
      out.push('//');

      var userInfo = this.getUserInfo();
      if (userInfo) {
        out.push(
          Uri.encodeSpecialChars_(
            userInfo,
            Uri.reDisallowedInSchemeOrUserInfo_,
            true
          ),
          '@'
        );
      }

      out.push(Uri.removeDoubleEncoding_(encodeURIComponent(domain)));

      var port = this.getPort();
      if (port != null) {
        out.push(':', String(port));
      }
    }

    var path = this.getPath();
    if (path) {
      if (this.hasDomain() && path.charAt(0) != '/') {
        out.push('/');
      }
      out.push(
        Uri.encodeSpecialChars_(
          path,
          path.charAt(0) == '/'
            ? Uri.reDisallowedInAbsolutePath_
            : Uri.reDisallowedInRelativePath_,
          true
        )
      );
    }

    var query = this.getEncodedQuery();
    if (query) {
      out.push('?', query);
    }

    var fragment = this.getFragment();
    if (fragment) {
      out.push(
        '#',
        Uri.encodeSpecialChars_(fragment, Uri.reDisallowedInFragment_)
      );
    }
    return out.join('');
  }

  resolve(relativeUri: Uri) {
    var absoluteUri = this.clone();
    if (absoluteUri.scheme_ === 'data') {
      // Cannot have a relative URI to a data URI.
      absoluteUri = new Uri();
    }

    // we satisfy these conditions by looking for the first part of relativeUri
    // that is not blank and applying defaults to the rest

    var overridden = relativeUri.hasScheme();

    if (overridden) {
      absoluteUri.setScheme(relativeUri.getScheme());
    } else {
      overridden = relativeUri.hasUserInfo();
    }

    if (overridden) {
      absoluteUri.setUserInfo(relativeUri.getUserInfo());
    } else {
      overridden = relativeUri.hasDomain();
    }

    if (overridden) {
      absoluteUri.setDomain(relativeUri.getDomain());
    } else {
      overridden = relativeUri.hasPort();
    }

    var path = relativeUri.getPath();
    if (overridden) {
      absoluteUri.setPort(relativeUri.getPort());
    } else {
      overridden = relativeUri.hasPath();
      if (overridden) {
        // resolve path properly
        if (path.charAt(0) != '/') {
          // path is relative
          if (this.hasDomain() && !this.hasPath()) {
            // RFC 3986, section 5.2.3, case 1
            path = '/' + path;
          } else {
            // RFC 3986, section 5.2.3, case 2
            var lastSlashIndex = absoluteUri.getPath().lastIndexOf('/');
            if (lastSlashIndex != -1) {
              path = absoluteUri.getPath().substr(0, lastSlashIndex + 1) + path;
            }
          }
        }
        path = Uri.removeDotSegments(path);
      }
    }

    if (overridden) {
      absoluteUri.setPath(path);
    } else {
      overridden = relativeUri.hasQuery();
    }

    if (overridden) {
      absoluteUri.setQueryData(relativeUri.getQueryData().clone());
    } else {
      overridden = relativeUri.hasFragment();
    }

    if (overridden) {
      absoluteUri.setFragment(relativeUri.getFragment());
    }

    return absoluteUri;
  }

  clone() {
    return new Uri(this);
  }

  /**
   * @return {string} The encoded scheme/protocol for the URI.
   */
  getScheme() {
    return this.scheme_;
  }

  /**
   * Sets the scheme/protocol.
   * @param {string} newScheme New scheme value.
   * @param {boolean=} decode Optional param for whether to decode new value.
   * @return {!goog.Uri} Reference to this URI object.
   */
  setScheme(newScheme: string, decode = false) {
    this.scheme_ = decode ? Uri.decodeOrEmpty_(newScheme, true) : newScheme;

    // remove an : at the end of the scheme so somebody can pass in
    // window.location.protocol
    if (this.scheme_) {
      this.scheme_ = this.scheme_.replace(/:$/, '');
    }
    return this;
  }

  /**
   * @return {boolean} Whether the scheme has been set.
   */
  hasScheme() {
    return !!this.scheme_;
  }

  /**
   * @return {string} The decoded user info.
   */
  getUserInfo() {
    return this.userInfo_;
  }

  /**
   * Sets the userInfo.
   * @param {string} newUserInfo New userInfo value.
   * @param {boolean=} decode Optional param for whether to decode new value.
   * @return {!goog.Uri} Reference to this URI object.
   */
  setUserInfo(newUserInfo: string, decode = false) {
    this.userInfo_ = decode ? Uri.decodeOrEmpty_(newUserInfo) : newUserInfo;
    return this;
  }

  /**
   * @return {boolean} Whether the user info has been set.
   */
  hasUserInfo() {
    return !!this.userInfo_;
  }

  /**
   * @return {string} The decoded domain.
   */
  getDomain() {
    return this.domain_;
  }

  /**
   * Sets the domain.
   * @param {string} newDomain New domain value.
   * @param {boolean=} decode Optional param for whether to decode new value.
   * @return {!goog.Uri} Reference to this URI object.
   */
  setDomain(newDomain: string, decode = false) {
    this.domain_ = decode ? Uri.decodeOrEmpty_(newDomain, true) : newDomain;
    return this;
  }

  /**
   * @return {boolean} Whether the domain has been set.
   */
  hasDomain() {
    return !!this.domain_;
  }

  /**
   * @return {?number} The port number.
   */
  getPort() {
    return this.port_;
  }

  /**
   * Sets the port number.
   * @param {*} newPort Port number. Will be explicitly casted to a number.
   * @return {!goog.Uri} Reference to this URI object.
   */
  setPort(newPort: number | null) {
    if (newPort) {
      newPort = Number(newPort);
      if (isNaN(newPort) || newPort < 0) {
        throw Error('Bad port number ' + newPort);
      }
      this.port_ = newPort;
    } else {
      this.port_ = null;
    }

    return this;
  }

  /**
   * @return {boolean} Whether the port has been set.
   */
  hasPort() {
    return this.port_ != null;
  }

  /**
   * @return {string} The decoded path.
   */
  getPath() {
    return this.path_;
  }

  /**
   * Sets the path.
   * @param {string} newPath New path value.
   * @param {boolean=} decode Optional param for whether to decode new value.
   * @return {!goog.Uri} Reference to this URI object.
   */
  setPath(newPath: string, decode = false) {
    this.path_ = decode ? Uri.decodeOrEmpty_(newPath, true) : newPath;
    return this;
  }

  /**
   * @return {boolean} Whether the path has been set.
   */
  hasPath() {
    return !!this.path_;
  }

  /**
   * @return {boolean} Whether the query string has been set.
   */
  hasQuery() {
    return this.queryData_.toString() !== '';
  }

  /**
   * Sets the query data.
   * @return {!goog.Uri} Reference to this URI object.
   */
  setQueryData(queryData: QueryData | string, decode = false) {
    if (queryData instanceof QueryData) {
      this.queryData_ = queryData;
    } else {
      if (!decode) {
        // QueryData accepts encoded query string, so encode it if
        // decode flag is not true.
        queryData = Uri.encodeSpecialChars_(
          queryData,
          Uri.reDisallowedInQuery_
        ) as string;
      }
      this.queryData_ = new QueryData(queryData as string);
    }

    return this;
  }

  /**
   * @return {string} The encoded URI query, not including the ?.
   */
  getEncodedQuery() {
    return this.queryData_.toString();
  }

  /**
   * @return {string} The decoded URI query, not including the ?.
   */
  getDecodedQuery() {
    return this.queryData_.toDecodedString();
  }

  /**
   * Returns the query data.
   * @return {!goog.Uri.QueryData} QueryData object.
   */
  getQueryData() {
    return this.queryData_;
  }

  /**
   * @return {string} The URI fragment, not including the #.
   */
  getFragment() {
    return this.fragment_;
  }

  /**
   * Sets the URI fragment.
   * @param {string} newFragment New fragment value.
   * @param {boolean=} decode Optional param for whether to decode new value.
   * @return {!goog.Uri} Reference to this URI object.
   */
  setFragment(newFragment: string, decode = false) {
    this.fragment_ = decode ? Uri.decodeOrEmpty_(newFragment) : newFragment;
    return this;
  }

  /**
   * @return {boolean} Whether the URI has a fragment set.
   */
  hasFragment() {
    return !!this.fragment_;
  }
  /**
   * Removes dot segments in given path component, as described in
   * RFC 3986, section 5.2.4.
   *
   * @param {string} path A non-empty path component.
   * @return {string} Path component with removed dot segments.
   */
  static removeDotSegments(path: string) {
    if (path == '..' || path == '.') {
      return '';
    } else if (path.indexOf('./') == -1 && path.indexOf('/.') == -1) {
      // This optimization detects uris which do not contain dot-segments,
      // and as a consequence do not require any processing.
      return path;
    } else {
      var leadingSlash = path.lastIndexOf('/', 0) == 0;
      var segments = path.split('/');
      var out = [];

      for (var pos = 0; pos < segments.length; ) {
        var segment = segments[pos++];

        if (segment == '.') {
          if (leadingSlash && pos == segments.length) {
            out.push('');
          }
        } else if (segment == '..') {
          if (out.length > 1 || (out.length == 1 && out[0] != '')) {
            out.pop();
          }
          if (leadingSlash && pos == segments.length) {
            out.push('');
          }
        } else {
          out.push(segment);
          leadingSlash = true;
        }
      }

      return out.join('/');
    }
  }

  /**
   * Decodes a value or returns the empty string if it isn't defined or empty.
   * @param {string|undefined} val Value to decode.
   * @param {boolean=} preserveReserved If true, restricted characters will
   *     not be decoded.
   * @return {string} Decoded value.
   * @private
   */
  static decodeOrEmpty_(val?: string, preserveReserved = false) {
    // Don't use UrlDecode() here because val is not a query parameter.
    if (!val) {
      return '';
    }

    return preserveReserved ? decodeURI(val) : decodeURIComponent(val);
  }

  /**
   * If unescapedPart is non null, then escapes any characters in it that aren't
   * valid characters in a url and also escapes any special characters that
   * appear in extra.
   *
   * @param {(?string|undefined)} unescapedPart The string to encode.
   * @param {RegExp} extra A character set of characters in [\01-\177].
   * @param {boolean=} removeDoubleEncoding If true, remove double percent
   *     encoding.
   * @return {?string} null iff unescapedPart == null.
   * @private
   */
  static encodeSpecialChars_(
    unescapedPart: string,
    extra: RegExp,
    removeDoubleEncoding?: boolean
  ) {
    if (unescapedPart != null) {
      var encoded = encodeURI(unescapedPart).replace(extra, Uri.encodeChar_);
      if (removeDoubleEncoding) {
        // encodeURI double-escapes %XX sequences used to represent restricted
        // characters in some URI components, remove the double escaping here.
        encoded = Uri.removeDoubleEncoding_(encoded);
      }
      return encoded;
    }
    return null;
  }

  /**
   * Converts a character in [\01-\177] to its unicode character equivalent.
   * @param {string} ch One character string.
   * @return {string} Encoded string.
   * @private
   */
  static encodeChar_(ch: string) {
    var n = ch.charCodeAt(0);
    return '%' + ((n >> 4) & 0xf).toString(16) + (n & 0xf).toString(16);
  }

  /**
   * Removes double percent-encoding from a string.
   * @param  {string} doubleEncodedString String
   * @return {string} String with double encoding removed.
   * @private
   */
  static removeDoubleEncoding_(doubleEncodedString: string) {
    return doubleEncodedString.replace(/%25([0-9a-fA-F]{2})/g, '%$1');
  }

  /**
   * Regular expression for characters that are disallowed in the scheme or
   * userInfo part of the URI.
   * @type {RegExp}
   * @private
   */
  static reDisallowedInSchemeOrUserInfo_ = /[#\/\?@]/g;

  /**
   * Regular expression for characters that are disallowed in a relative path.
   * Colon is included due to RFC 3986 3.3.
   * @type {RegExp}
   * @private
   */
  static reDisallowedInRelativePath_ = /[\#\?:]/g;

  /**
   * Regular expression for characters that are disallowed in an absolute path.
   * @type {RegExp}
   * @private
   */
  static reDisallowedInAbsolutePath_ = /[\#\?]/g;

  /**
   * Regular expression for characters that are disallowed in the query.
   * @type {RegExp}
   * @private
   */
  static reDisallowedInQuery_ = /[\#\?@]/g;

  /**
   * Regular expression for characters that are disallowed in the fragment.
   * @type {RegExp}
   * @private
   */
  static reDisallowedInFragment_ = /#/g;
}

/**
 * Class used to represent URI query parameters.  It is essentially a hash of
 * name-value pairs, though a name can be present more than once.
 *
 * Has the same interface as the collections in structs.
 * @final
 */
export class QueryData {
  private encodedQuery_?: string | null = null;
  private keyMap_: Record<string, string[]> | null = null;
  private count_: number | null = null;
  constructor(query?: string | null) {
    this.encodedQuery_ = query;
  }

  ensureKeyMapInitialized_() {
    if (!this.keyMap_) {
      this.keyMap_ = {};
      this.count_ = 0;

      if (this.encodedQuery_) {
        var pairs = this.encodedQuery_.split('&');
        for (var i = 0; i < pairs.length; i++) {
          var indexOfEquals = pairs[i].indexOf('=');
          var name = null;
          var value = null;
          if (indexOfEquals >= 0) {
            name = pairs[i].substring(0, indexOfEquals);
            value = pairs[i].substring(indexOfEquals + 1);
          } else {
            name = pairs[i];
          }
          name = decodeURIComponent(name.replace(/\+/g, ' '));
          value = value || '';
          this.add(name, decodeURIComponent(value.replace(/\+/g, ' ')));
        }
      }
    }
  }

  getCount(): number {
    this.ensureKeyMapInitialized_();
    return this.count_!;
  }
  add(key: string, value: string) {
    this.ensureKeyMapInitialized_();
    // Invalidate the cache.
    this.encodedQuery_ = null;

    var values = this.keyMap_!.hasOwnProperty(key) ? this.keyMap_![key] : null;
    if (!values) {
      this.keyMap_![key] = values = [];
    }
    values.push(value);
    this.count_!++;
    return this;
  }
  set(key: string, value: string) {
    this.ensureKeyMapInitialized_();
    // Invalidate the cache.
    this.encodedQuery_ = null;

    if (!this.keyMap_!.hasOwnProperty(key)) {
      this.add(key, value);
    } else {
      this.keyMap_![key] = [value];
    }

    return this;
  }

  get(key: string) {
    this.ensureKeyMapInitialized_();
    return this.keyMap_![key] || [];
  }

  toString() {
    if (this.encodedQuery_) {
      return this.encodedQuery_;
    }

    if (!this.keyMap_) {
      return '';
    }

    var sb = [];

    for (var key in this.keyMap_) {
      var encodedKey = encodeURIComponent(key);
      var val = this.keyMap_[key];
      for (var j = 0; j < val.length; j++) {
        var param = encodedKey;
        // Ensure that null and undefined are encoded into the url as
        // literal strings.
        if (val[j] !== '') {
          param += '=' + encodeURIComponent(val[j]);
        }
        sb.push(param);
      }
    }

    return (this.encodedQuery_ = sb.join('&'));
  }

  toDecodedString() {
    return Uri.decodeOrEmpty_(this.toString());
  }

  clone() {
    const rv = new QueryData();
    rv.encodedQuery_ = this.encodedQuery_;
    if (this.keyMap_) {
      var cloneMap: Record<string, string[]> = {};
      for (var key in this.keyMap_) {
        cloneMap[key] = this.keyMap_[key].concat();
      }
      rv.keyMap_ = cloneMap;
      rv.count_ = this.count_;
    }
    return rv;
  }
}
