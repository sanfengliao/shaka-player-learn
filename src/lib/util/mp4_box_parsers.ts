import { DataViewReader } from './data_view_reader';

export class Mp4BoxParsers {
  static parseHFOV(reader: DataViewReader) {
    const millidegrees = reader.readUint32();

    return {
      hfov: millidegrees / 1000,
    };
  }
  static parseHDLR(reader: DataViewReader) {
    reader.skip(8); // Skip "pre_defined"

    const handlerType = reader.readTerminatedString();
    return { handlerType };
  }
  /**
   * Parses a TFDT Box, with a loss of precision beyond 53 bits.
   * Use only when exact integers are not required, e.g. when
   * dividing by the timescale.
   * @param reader
   * @param version
   */
  static parseTFDTInaccurate(reader: DataViewReader, version: number) {
    if (version == 1) {
      const high = reader.readUint32();
      const low = reader.readUint32();
      return {
        baseMediaDecodeTime: high * Math.pow(2, 32) + low,
      };
    } else {
      return {
        baseMediaDecodeTime: reader.readUint32(),
      };
    }
  }

  /**
   * Parses a PRFT Box, with a loss of precision beyond 53 bits.
   * Use only when exact integers are not required, e.g. when
   * dividing by the timescale.
   *
   * @param reader
   * @param version
   * @return
   */
  static parsePRFTInaccurate(reader: DataViewReader, version: number) {
    reader.readUint32(); // Ignore referenceTrackId
    const ntpTimestampSec = reader.readUint32();
    const ntpTimestampFrac = reader.readUint32();
    const ntpTimestamp = ntpTimestampSec * 1000 + (ntpTimestampFrac / 2 ** 32) * 1000;

    let mediaTime;
    if (version === 0) {
      mediaTime = reader.readUint32();
    } else {
      const high = reader.readUint32();
      const low = reader.readUint32();
      mediaTime = high * Math.pow(2, 32) + low;
    }
    return {
      mediaTime,
      ntpTimestamp,
    };
  }

  /**
   * Parses a MDHD Box.
   * @param reader
   * @param version
   * @return {!shaka.util.ParsedMDHDBox}
   */
  static parseMDHD(reader: DataViewReader, version: number): ParsedMDHDBox {
    if (version == 1) {
      reader.skip(8); // Skip "creation_time"
      reader.skip(8); // Skip "modification_time"
    } else {
      reader.skip(4); // Skip "creation_time"
      reader.skip(4); // Skip "modification_time"
    }

    const timescale = reader.readUint32();

    reader.skip(4); // Skip "duration"

    const language = reader.readUint16();

    // language is stored as an ISO-639-2/T code in an array of three
    // 5-bit fields each field is the packed difference between its ASCII
    // value and 0x60
    const languageString =
      String.fromCharCode((language >> 10) + 0x60) +
      String.fromCharCode(((language & 0x03c0) >> 5) + 0x60) +
      String.fromCharCode((language & 0x1f) + 0x60);

    return {
      timescale,
      language: languageString,
    };
  }

  static parsePRJI(reader: DataViewReader) {
    const projection = reader.readTerminatedString();
    return { projection };
  }
}

export interface ParsedMDHDBox {
  /**
   * As per the spec: an integer that specifies the time‐scale for this media;
   * this is the number of time units that pass in one second
   */
  timescale: number;
  //  Language code for this media
  language: string;
}

export interface ParsedPRFTBox {
  mediaTime: number;
  ntpTimestamp: number;
}
