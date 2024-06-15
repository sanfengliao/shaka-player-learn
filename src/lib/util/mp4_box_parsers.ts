import { DataViewReader } from './data_view_reader';

export class Mp4BoxParsers {
  /**
   * Parses a TFDT Box, with a loss of precision beyond 53 bits.
   * Use only when exact integers are not required, e.g. when
   * dividing by the timescale.
   * @param reader
   * @param version
   */
  static parseTFDTInaccurate(reader: DataViewReader, version: number) {
    if (version === 1) {
      const high = reader.readUint32();
      const low = reader.readInt32();
      return {
        baseMediaDecodeTime: high * Math.pow(2, 32) + low,
      };
    } else {
      return {
        baseMediaDecodeTime: reader.readUint32(),
      };
    }
  }
}
