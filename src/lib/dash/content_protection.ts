import { XmlNode } from '../../externs/shaka';
import { DrmInfo, InitDataOverride } from '../../externs/shaka/manifest';
import { asserts } from '../debug/asserts';
import { log } from '../debug/log';
import { BufferUtils } from '../util/buffer_utils';
import { ShakaError } from '../util/error';
import { ManifestParserUtils } from '../util/manifest_parser_utils';
import { Pssh } from '../util/pssh';
import { StringUtils } from '../util/string_utils';
import { TXml } from '../util/tXml';
import { Uint8ArrayUtils } from '../util/uint8array_utils';

/**
 * @summary A set of functions for parsing and interpreting ContentProtection
 *   elements.
 */
export class ContentProtection {
  private static licenseUrlParsers_: Map<string, (ele: ContentProtectionElement) => string> = new Map()
    .set('com.widevine.alpha', ContentProtection.getWidevineLicenseUrl)
    .set('com.microsoft.playready', ContentProtection.getPlayReadyLicenseUrl)
    .set('com.microsoft.playready.recommendation', ContentProtection.getPlayReadyLicenseUrl)
    .set('com.microsoft.playready.software', ContentProtection.getPlayReadyLicenseUrl)
    .set('com.microsoft.playready.hardware', ContentProtection.getPlayReadyLicenseUrl)
    .set('org.w3.clearkey', ContentProtection.getClearKeyLicenseUrl);
  private static MP4Protection_ = 'urn:mpeg:dash:mp4protection:2011';
  private static Aes128Protection_ = 'urn:mpeg:dash:sea:2012';
  private static CencNamespaceUri_ = 'urn:mpeg:cenc:2013';
  private static ClearKeyNamespaceUri_ = 'http://dashif.org/guidelines/clearKey';
  private static ClearKeySchemeUri_ = 'urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e';
  private static DashIfNamespaceUri_ = 'https://dashif.org/CPS';

  /**
   * Parses info from the ContentProtection elements at the AdaptationSet level.
   *
   * @param elems
   * @param ignoreDrmInfo
   * @param keySystemsByURI
   * @return
   */
  static parseFromAdaptationSet(
    elems: XmlNode[],
    ignoreDrmInfo: boolean,
    keySystemsByURI: Record<string, string>
  ): ContentProtectionContext {
    const parsed = ContentProtection.praseElements_(elems);
    let defaultInit: InitDataOverride[] | null = null;
    let drmInfos: DrmInfo[] = [];
    let parsedNonCenc: ContentProtectionElement[] = [];
    let aes128Info: ContentProtectionAes128Info | null = null;

    // Get the default key ID; if there are multiple, they must all match.
    const keyIds = new Set(parsed.map((ele) => ele.keyId).filter((id) => !!id)) as Set<string>;

    let encryptionScheme = 'cenc';
    if (keyIds.size > 1) {
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.MANIFEST,
        ShakaError.Code.DASH_CONFLICTING_KEY_IDS
      );
    }
    if (!ignoreDrmInfo) {
      const aes128Elements = parsed.filter((ele) => {
        return ele.schemeUri === ContentProtection.Aes128Protection_;
      });
      if (aes128Elements.length > 1) {
        throw new ShakaError(
          ShakaError.Severity.CRITICAL,
          ShakaError.Category.MANIFEST,
          ShakaError.Code.DASH_CONFLICTING_AES_128
        );
      }
      if (aes128Elements.length) {
        aes128Info = ContentProtection.parseAes128_(aes128Elements[0]);
      }

      const mp4ProtectionParsed = parsed.find((ele) => {
        return ele.schemeUri === ContentProtection.MP4Protection_;
      });

      if (mp4ProtectionParsed && mp4ProtectionParsed.encryptionScheme) {
        encryptionScheme = mp4ProtectionParsed.encryptionScheme;
      }

      // Find the default key ID and init data.  Create a new array of all the
      // non-CENC elements.

      parsedNonCenc = parsed.filter((ele) => {
        if (ele.schemeUri === ContentProtection.MP4Protection_) {
          asserts.assert(!ele.init || ele.init.length, 'Init data must be null or non-empty.');
          defaultInit = ele.init || defaultInit;
          return false;
        } else {
          return ele.schemeUri != ContentProtection.Aes128Protection_;
        }
      });

      if (parsedNonCenc.length) {
        drmInfos = ContentProtection.convertElements_(
          defaultInit!,
          encryptionScheme,
          parsedNonCenc,
          keySystemsByURI,
          keyIds
        );

        // If there are no drmInfos after parsing, then add a dummy entry.
        // This may be removed in parseKeyIds.
        if (drmInfos.length == 0) {
          drmInfos = [ManifestParserUtils.createDrmInfo('', encryptionScheme, defaultInit)];
        }
      }
    }

    // If there are only CENC element(s) or ignoreDrmInfo flag is set, assume
    // all key-systems are supported.
    if (parsed.length && !aes128Info && (ignoreDrmInfo || !parsedNonCenc.length)) {
      drmInfos = [];

      for (const keySystem of Object.values(keySystemsByURI)) {
        // If the manifest doesn't specify any key systems, we shouldn't
        // put clearkey in this list.  Otherwise, it may be triggered when
        // a real key system should be used instead.
        if (keySystem != 'org.w3.clearkey') {
          const info = ManifestParserUtils.createDrmInfo(keySystem, encryptionScheme, defaultInit);
          drmInfos.push(info);
        }
      }
    }

    const defaultKeyId = Array.from(keyIds)[0] || null;

    if (defaultKeyId) {
      for (const info of drmInfos) {
        for (const initData of info.initData) {
          initData.keyId = defaultKeyId;
        }
      }
    }

    return {
      defaultKeyId: defaultKeyId,
      defaultInit: defaultInit,
      drmInfos: drmInfos,
      aes128Info: aes128Info,
      firstRepresentation: true,
    };
  }

  /**
   * Parses the given ContentProtection elements found at the Representation
   * level.  This may update the |context|.
   *
   * @param elems
   * @param context
   * @param ignoreDrmInfo
   * @param keySystemsByURI
   * @return The parsed key ID
   */
  static parseFromRepresentation(
    elems: XmlNode[],
    context: ContentProtectionContext,
    ignoreDrmInfo: boolean,
    keySystemsByURI: Record<string, string>
  ): string | null | undefined {
    const repContext = ContentProtection.parseFromAdaptationSet(elems, ignoreDrmInfo, keySystemsByURI);
    if (context.firstRepresentation) {
      const asUnknown = context.drmInfos.length == 1 && !context.drmInfos[0].keySystem;
      const asUnencrypted = context.drmInfos.length == 0;
      const repUnencrypted = repContext.drmInfos.length == 0;

      // There are two cases where we need to replace the |drmInfos| in the
      // context with those in the Representation:
      //   1. The AdaptationSet does not list any ContentProtection.
      //   2. The AdaptationSet only lists unknown key-systems.
      if (asUnencrypted || (asUnknown && !repUnencrypted)) {
        context.drmInfos = repContext.drmInfos;
      }
      context.firstRepresentation = false;
    } else if (repContext.drmInfos.length > 0) {
      // If this is not the first Representation, then we need to remove entries
      // from the context that do not appear in this Representation.
      context.drmInfos = context.drmInfos.filter((asInfo) => {
        return repContext.drmInfos.some((repInfo) => {
          return repInfo.keySystem == asInfo.keySystem;
        });
      });
      // If we have filtered out all key-systems, throw an error.
      if (context.drmInfos.length == 0) {
        throw new ShakaError(
          ShakaError.Severity.CRITICAL,
          ShakaError.Category.MANIFEST,
          ShakaError.Code.DASH_NO_COMMON_KEY_SYSTEM
        );
      }
    }
    return repContext.defaultKeyId || context.defaultKeyId;
  }

  /**
   * Creates DrmInfo objects from the given element.
   *
   * @param  defaultInit
   * @param  encryptionScheme
   * @param  elements
   * @param  keySystemsByURI
   * @param  keyIds
   * @return
   * @private
   */
  private static convertElements_(
    defaultInit: InitDataOverride[],
    encryptionScheme: string,
    elements: ContentProtectionElement[],
    keySystemsByURI: Record<string, string>,
    keyIds: Set<string>
  ): DrmInfo[] {
    const out: DrmInfo[] = [];

    for (const element of elements) {
      const keySystem = keySystemsByURI[element.schemeUri];
      if (keySystem) {
        asserts.assert(!element.init || element.init.length, 'Init data must be null or non-empty.');
      }
      const proInitData = ContentProtection.getInitDataFromPro_(element);
      let clearKeyInitData = null;
      if (element.schemeUri === ContentProtection.ClearKeySchemeUri_) {
        clearKeyInitData = ContentProtection.getInitDataClearKey_(element, keyIds);
      }

      const initData = element.init || defaultInit || proInitData || clearKeyInitData;
      const info = ManifestParserUtils.createDrmInfo(keySystem, encryptionScheme, initData);
      const licenseParser = ContentProtection.licenseUrlParsers_.get(keySystem);
      if (licenseParser) {
        info.licenseServerUri = licenseParser(element);
      }

      out.push(info);
    }

    return out;
  }

  /**
   * Creates ClearKey initData from Default_KID value retrieved from previously
   * parsed ContentProtection tag.
   * @param element
   * @param keyIds
   * @return
   * @private
   */
  static getInitDataClearKey_(element: ContentProtectionElement, keyIds: Set<string>): InitDataOverride[] | null {
    if (keyIds.size == 0) {
      return null;
    }

    const systemId = new Uint8Array([
      0x10, 0x77, 0xef, 0xec, 0xc0, 0xb2, 0x4d, 0x02, 0xac, 0xe3, 0x3c, 0x1e, 0x52, 0xe2, 0xfb, 0x4b,
    ]);
    const data = new Uint8Array([]);
    const psshVersion = 1;
    const pssh = Pssh.createPssh(data, systemId, keyIds, psshVersion);

    return [
      {
        initData: pssh,
        initDataType: 'cenc',
        keyId: element.keyId,
      },
    ];
  }

  /**
   * Gets a PlayReady initData from a content protection element
   * containing a PlayReady Pro Object
   *
   * @paramelement
   * @return
   * @private
   */
  static getInitDataFromPro_(element: ContentProtectionElement): InitDataOverride[] | null {
    const proNode = TXml.findChildNS(element.node, 'urn:microsoft:playready', 'pro');
    if (!proNode || !TXml.getTextContents(proNode)) {
      return null;
    }
    const textContent = TXml.getTextContents(proNode) as string;
    const data = Uint8ArrayUtils.fromBase64(textContent);
    const systemId = new Uint8Array([
      0x9a, 0x04, 0xf0, 0x79, 0x98, 0x40, 0x42, 0x86, 0xab, 0x92, 0xe6, 0x5b, 0xe0, 0x88, 0x5f, 0x95,
    ]);
    const keyIds = new Set<string>();
    const psshVersion = 0;
    const pssh = Pssh.createPssh(data, systemId, keyIds, psshVersion);
    return [
      {
        initData: pssh,
        initDataType: 'cenc',
        keyId: element.keyId,
      },
    ];
  }

  /**
   * Gets a Widevine license URL from a content protection element
   * containing a custom `ms:laurl` or 'dashif:Laurl' elements
   *
   */
  static getWidevineLicenseUrl(element: ContentProtectionElement) {
    const dashIfLaurlNode = TXml.findChildNS(element.node, ContentProtection.DashIfNamespaceUri_, 'Laurl');

    if (dashIfLaurlNode) {
      const textContents = TXml.getTextContents(dashIfLaurlNode);
      if (textContents) {
        return textContents;
      }
    }
    const mslaurlNode = TXml.findChildNS(element.node, 'urn:microsoft', 'laurl');
    if (mslaurlNode) {
      return StringUtils.htmlUnescape(mslaurlNode.attributes['licenseUrl']) || '';
    }
    return '';
  }

  /**
   * Gets a ClearKey license URL from a content protection element
   * containing a custom `clearkey::Laurl` or 'dashif:Laurl' elements
   *
   * @param element
   * @return {string}
   */
  static getClearKeyLicenseUrl(element: ContentProtectionElement) {
    const dashIfLaurlNode = TXml.findChildNS(element.node, ContentProtection.DashIfNamespaceUri_, 'Laurl');
    if (dashIfLaurlNode) {
      const textContents = TXml.getTextContents(dashIfLaurlNode);
      if (textContents) {
        return textContents;
      }
    }
    const clearKeyLaurlNode = TXml.findChildNS(element.node, ContentProtection.ClearKeyNamespaceUri_, 'Laurl');
    if (clearKeyLaurlNode && clearKeyLaurlNode.attributes['Lic_type'] === 'EME-1.0') {
      if (clearKeyLaurlNode) {
        const textContents = TXml.getTextContents(clearKeyLaurlNode);
        if (textContents) {
          return textContents;
        }
      }
    }
    return '';
  }

  /**
   * Gets a PlayReady license URL from a content protection element
   * containing a PlayReady Header Object
   *
   * @param element
   * @return {string}
   */
  static getPlayReadyLicenseUrl(element: ContentProtectionElement) {
    const dashIfLaurlNode = TXml.findChildNS(element.node, ContentProtection.DashIfNamespaceUri_, 'Laurl');
    if (dashIfLaurlNode) {
      const textContents = TXml.getTextContents(dashIfLaurlNode);
      if (textContents) {
        return textContents;
      }
    }

    const proNode = TXml.findChildNS(element.node, 'urn:microsoft:playready', 'pro');

    if (!proNode || !TXml.getTextContents(proNode)) {
      return '';
    }

    const textContent = TXml.getTextContents(proNode) as string;
    const bytes = Uint8ArrayUtils.fromBase64(textContent);
    const records = ContentProtection.parseMsPro_(bytes);
    const record = records.filter((record) => {
      return record.type === ContentProtectionPlayReadyRecordTypes.RIGHTS_MANAGEMENT;
    })[0];

    if (!record) {
      return '';
    }

    const xml = StringUtils.fromUTF16(record.value, true);
    const rootElement = TXml.parseXmlString(xml, 'WRMHEADER');
    if (!rootElement) {
      return '';
    }

    return ContentProtection.getLaurl_(rootElement as XmlNode);
  }
  private static getLaurl_(xml: XmlNode) {
    // LA_URL element is optional and no more than one is
    // allowed inside the DATA element. Only absolute URLs are allowed.
    // If the LA_URL element exists, it must not be empty.
    for (const elem of TXml.getElementsByTagName(xml, 'DATA')) {
      if (elem.children) {
        for (const child of elem.children) {
          // @ts-expect-error
          if (child.tagName == 'LA_URL') {
            return TXml.getTextContents(child);
          }
        }
      }
    }

    // Not found
    return '';
  }

  /**
   * Parses a buffer for PlayReady Objects.  The data
   * should contain a 32-bit integer indicating the length of
   * the PRO in bytes.  Following that, a 16-bit integer for
   * the number of PlayReady Object Records in the PRO.  Lastly,
   * a byte array of the PRO Records themselves.
   *
   * PlayReady Object format: https://goo.gl/W8yAN4
   *
   * @param data
   * @return
   * @private
   */
  private static parseMsPro_(data: BufferSource): ContentProtectionPlayReadyRecord[] {
    let byteOffset = 0;
    const view = BufferUtils.toDataView(data);

    // First 4 bytes is the PRO length (DWORD)
    const byteLength = view.getUint32(byteOffset, /* littleEndian= */ true);
    byteOffset += 4;

    if (byteLength != data.byteLength) {
      // Malformed PRO
      log.warning('PlayReady Object with invalid length encountered.');
      return [];
    }

    // Skip PRO Record count (WORD)
    byteOffset += 2;

    // Rest of the data contains the PRO Records

    return ContentProtection.parseMsProRecords_(view, byteOffset);
  }

  /**
   * Parses an Array buffer starting at byteOffset for PlayReady Object Records.
   * Each PRO Record is preceded by its PlayReady Record type and length in
   * bytes.
   *
   * PlayReady Object Record format: https://goo.gl/FTcu46
   *
   * @param view
   * @param byteOffset
   * @return
   * @private
   */
  private static parseMsProRecords_(view: DataView, byteOffset: number): ContentProtectionPlayReadyRecord[] {
    const records: ContentProtectionPlayReadyRecord[] = [];

    while (byteOffset < view.byteLength - 1) {
      const type = view.getUint16(byteOffset, true);
      byteOffset += 2;

      const byteLength = view.getUint16(byteOffset, true);
      byteOffset += 2;

      if ((byteLength & 1) != 0 || byteLength + byteOffset > view.byteLength) {
        log.warning('Malformed MS PRO object');
        return [];
      }

      const recordValue = BufferUtils.toUint8(view, byteOffset, byteLength);
      records.push({
        type: type,
        value: recordValue,
      });

      byteOffset += byteLength;
    }

    return records;
  }

  private static parseAes128_(element: ContentProtectionElement): ContentProtectionAes128Info {
    if (!window.crypto || !window.crypto.subtle) {
      log.alwaysWarn(
        'Web Crypto API is not available to decrypt ' + 'AES-128. (Web Crypto only exists in secure origins like https)'
      );
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.MANIFEST,
        ShakaError.Code.NO_WEB_CRYPTO_API
      );
    }

    const namespace = 'urn:mpeg:dash:schema:sea:2012';
    const segmentEncryption = TXml.findChildNS(element.node, namespace, 'SegmentEncryption');

    if (!segmentEncryption) {
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.MANIFEST,
        ShakaError.Code.DASH_UNSUPPORTED_AES_128
      );
    }

    const aesSchemeIdUri = 'urn:mpeg:dash:sea:aes128-cbc:2013';
    const segmentEncryptionSchemeIdUri = segmentEncryption.attributes['schemeIdUri'];
    if (aesSchemeIdUri !== segmentEncryptionSchemeIdUri) {
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.MANIFEST,
        ShakaError.Code.DASH_UNSUPPORTED_AES_128
      );
    }

    const cryptoPeriod = TXml.findChildNS(element.node, namespace, 'CryptoPeriod');

    if (!cryptoPeriod) {
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.MANIFEST,
        ShakaError.Code.DASH_UNSUPPORTED_AES_128
      );
    }

    const ivHex = cryptoPeriod.attributes['IV'];
    const keyUri = StringUtils.htmlUnescape(cryptoPeriod.attributes['keyUriTemplate']);
    if (!ivHex || !keyUri) {
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.MANIFEST,
        ShakaError.Code.DASH_UNSUPPORTED_AES_128
      );
    }
    const iv = Uint8ArrayUtils.fromHex(ivHex.substr(2));

    if (iv.byteLength !== 16) {
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.MANIFEST,
        ShakaError.Code.AES_128_INVALID_IV_LENGTH
      );
    }
    return {
      keyUri,
      iv,
    };
  }

  /**
   * Parses the given ContentProtection elements.  If there is an error, it
   * removes those elements.
   */
  private static praseElements_(elems: XmlNode[]) {
    const out: ContentProtectionElement[] = [];
    for (const elem of elems) {
      const parsed = ContentProtection.parseElement_(elem);
      if (parsed) {
        out.push(parsed);
      }
    }
    return out;
  }

  /**
   * Parses the given ContentProtection element.
   *
   * @param  elem
   * @return
   */
  private static parseElement_(elem: XmlNode): ContentProtectionElement | null {
    const NS = ContentProtection.CencNamespaceUri_;
    let schemeUri = elem.attributes['schemeIdUri'];
    let keyId = TXml.getAttributeNS(elem, NS, 'default_KID');
    const psshs = TXml.findChildrenNS(elem, NS, 'pssh')
      .map(TXml.getContents)
      .filter((i) => !!i);

    const encryptionScheme = elem.attributes['value'];

    if (!schemeUri) {
      log.error('Missing required schemeIdUri attribute on', 'ContentProtection element', elem);
      return null;
    }

    schemeUri = schemeUri.toLowerCase();
    if (keyId) {
      keyId = keyId.replace(/-/g, '').toLowerCase();
      if (keyId.includes(' ')) {
        throw new ShakaError(
          ShakaError.Severity.CRITICAL,
          ShakaError.Category.MANIFEST,
          ShakaError.Code.DASH_MULTIPLE_KEY_IDS_NOT_SUPPORTED
        );
      }
    }
    let init: InitDataOverride[] = [];
    try {
      // Try parsing PSSH data.
      init = psshs.map((pssh) => {
        return {
          initDataType: 'cenc',
          initData: Uint8ArrayUtils.fromBase64(pssh!),
          keyId: null,
        };
      });
    } catch (e) {
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.MANIFEST,
        ShakaError.Code.DASH_PSSH_BAD_ENCODING
      );
    }

    return {
      node: elem,
      schemeUri,
      keyId,
      init: init.length > 0 ? init : null,
      encryptionScheme,
    };
  }
}

/**
 * The parsed result of a PlayReady object record.
 */
export interface ContentProtectionPlayReadyRecord {
  // Type of data stored in the record.
  type: ContentProtectionPlayReadyRecordTypes;
  // Record content.
  value: Uint8Array;
}

/**
 * Enum for PlayReady record types.
 */
export const enum ContentProtectionPlayReadyRecordTypes {
  RIGHTS_MANAGEMENT = 0x001,
  RESERVED = 0x002,
  EMBEDDED_LICENSE = 0x003,
}

/**
 * Contains information about the ContentProtection elements found at the
 * AdaptationSet level.
 */
export interface ContentProtectionContext {
  /**
   * The default key ID to use.  This is used by parseKeyIds as a default.  This
   * can be null to indicate that there is no default.
   */
  defaultKeyId?: string | null;
  /**
   * The default init data override.  This can be null to indicate that there
   * is no default.
   */
  defaultInit: InitDataOverride[] | null;
  drmInfos: DrmInfo[];
  aes128Info?: ContentProtectionAes128Info | null;
  /**
   * True when first parsed; changed to false after the first call to
   * parseKeyIds.  This is used to determine if a dummy key-system should be
   * overwritten; namely that the first representation can replace the dummy
   * from the AdaptationSet.
   */
  firstRepresentation: boolean;
}

/**
 * Contains information about the AES-128 keyUri and IV found at the
 * AdaptationSet level.
 */
export interface ContentProtectionAes128Info {
  // The keyUri in the manifest.
  keyUri: string;
  // The IV in the manifest.
  iv: Uint8Array;
}

export interface ContentProtectionElement {
  node: XmlNode;
  schemeUri: string;
  keyId?: string;
  /**
   * The init data, if present.  If there is no init data, it will be null.  If
   * this is non-null, there is at least one element.
   */
  init: InitDataOverride[] | null;

  encryptionScheme?: string;
}
