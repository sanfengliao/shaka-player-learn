import { ParsedBox } from '../../externs/shaka/mp4_parser';
import { asserts } from '../debug/asserts';
import { log } from '../debug/log';
import { BufferUtils } from './buffer_utils';
import { Mp4Parser } from './mp4_parser';
import { Uint8ArrayUtils } from './uint8array_utils';

/**
 * parse a PSSH box and extract the system IDs.
 */
export class Pssh {
  systemIds: string[] = [];
  cencKeyIds: string[] = [];
  data: Uint8Array[] = [];
  constructor(psshBox: Uint8Array) {
    new Mp4Parser()
      .box('moov', Mp4Parser.children)
      .box('moof', Mp4Parser.children)
      .fullBox('pssh', (box) => this.parsePsshBox_(box))
      .parse(psshBox);
    if (this.data.length == 0) {
      log.v2('No pssh box found!');
    }
  }
  private parsePsshBox_(box: ParsedBox): void {
    asserts.assert(box.version != null, 'PSSH boxes are full boxes and must have a valid version');

    asserts.assert(box.flags != null, 'PSSH boxes are full boxes and must have a valid flag');

    if (Number(box.version) > 1) {
      log.warning('Unrecognized PSSH version found!');
      return;
    }

    // The "reader" gives us a view on the payload of the box.  Create a new
    // view that contains the whole box.
    const dataView = box.reader.getDataView();
    asserts.assert(dataView.byteOffset >= 12, 'DataView at incorrect position');
    const pssh = BufferUtils.toUint8(dataView, -12, box.size);
    this.data.push(pssh);

    this.systemIds.push(Uint8ArrayUtils.toHex(box.reader.readBytes(16)));
    if (Number(box.version) > 0) {
      const numKeyIds = box.reader.readUint32();
      for (let i = 0; i < numKeyIds; i++) {
        const keyId = Uint8ArrayUtils.toHex(box.reader.readBytes(16));
        this.cencKeyIds.push(keyId);
      }
    }
  }

  /**
   * Creates a pssh blob from the given system ID, data, keyIds and version.
   *
   * @param data
   * @param systemId
   * @param keyIds
   * @param version
   * @return
   */
  static createPssh(data: Uint8Array, systemId: Uint8Array, keyIds: Set<string>, version: number) {
    asserts.assert(systemId.byteLength == 16, 'Invalid system ID length');
    const dataLength = data.length;
    let psshSize = 0x4 + 0x4 + 0x4 + systemId.length + 0x4 + dataLength;
    if (version > 0) {
      psshSize += 0x4 + 16 * keyIds.size;
    }
    const psshBox = new Uint8Array(psshSize);

    const psshData = BufferUtils.toDataView(psshBox);
    let byteCursor = 0;
    // 设置size
    psshData.setUint32(byteCursor, psshSize);
    byteCursor += 0x4;
    // 设置type
    psshData.setUint32(byteCursor, 0x70737368); // 'pssh'
    byteCursor += 0x4;
    version < 1 ? psshData.setUint32(byteCursor, 0) : psshData.setUint32(byteCursor, 0x01000000); // version + flags
    byteCursor += 0x4;
    psshBox.set(systemId, byteCursor);
    byteCursor += systemId.length;

    // if version > 0, add KID count and kid values.
    if (version > 0) {
      psshData.setUint32(byteCursor, keyIds.size); // KID_count
      byteCursor += 0x4;
      for (const keyId of keyIds) {
        const KID = Uint8ArrayUtils.fromHex(keyId);
        psshBox.set(KID, byteCursor);
        byteCursor += KID.length;
      }
    }

    psshData.setUint32(byteCursor, dataLength);
    byteCursor += 0x4;

    psshBox.set(data, byteCursor);
    byteCursor += dataLength;

    asserts.assert(byteCursor === psshSize, 'PSSH invalid length.');
    return psshBox;
  }

  /**
   * Normalise the initData array. This is to apply browser specific
   * work-arounds, e.g. removing duplicates which appears to occur
   * intermittently when the native msneedkey event fires (i.e. event.initData
   * contains dupes).
   *
   * @param initData
   * @return
   */

  static normaliseInitData(initData: Uint8Array) {
    if (!initData) {
      return initData;
    }

    const pssh = new Pssh(initData);
    // If there is only a single pssh, return the original array.
    if (pssh.data.length <= 1) {
      return initData;
    }

    const dedupedInitDatas: Uint8Array[] = [];
    for (const initData of pssh.data) {
      const found = dedupedInitDatas.some((x) => {
        return BufferUtils.equal(x, initData);
      });

      if (!found) {
        dedupedInitDatas.push(initData);
      }
    }
    return Uint8ArrayUtils.concat(...dedupedInitDatas);
  }
}
