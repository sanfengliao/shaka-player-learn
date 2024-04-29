/**
 * @summary
 * This is for capturing all media source capabilities on current platform.
 * And this is for static check and can not be constructed.
 */

export class Capabilities {
  static MediaSourceTypeSupportMap = new Map();
  /**
   * Cache browser engine call to improve performance on some poor platforms
   *
   * @param {string} type
   * @return {boolean}
   */
  static isTypeSupported(type: string) {
    const supportMap = Capabilities.MediaSourceTypeSupportMap;
    if (supportMap.has(type)) {
      return supportMap.get(type);
    }

    // @ts-ignore
    if (window.ManagedMediaSource) {
      // @ts-ignore
      const currentSupport = ManagedMediaSource.isTypeSupported(type);
      supportMap.set(type, currentSupport);
      return currentSupport;
    } else if (window.MediaSource) {
      const currentSupport = MediaSource.isTypeSupported(type);
      supportMap.set(type, currentSupport);
      return currentSupport;
    }
    return false;
  }

  /**
   * Determine support for SourceBuffer.changeType
   * @return {boolean}
   */
  static isChangeTypeSupported() {
    return (
      !!window.SourceBuffer &&
      // eslint-disable-next-line no-restricted-syntax
      !!SourceBuffer.prototype &&
      !!SourceBuffer.prototype.changeType
    );
  }
}
