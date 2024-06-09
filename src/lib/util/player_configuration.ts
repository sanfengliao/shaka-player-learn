import { XmlNode } from '../../externs/shaka';
import { ConfigUtils } from './config_utils';

export class PlayerConfiguration {
  /**
   * @param element
   * @return
   */
  static defaultManifestPreprocessor(element: Element) {
    return ConfigUtils.referenceParametersAndReturn([element], element);
  }

  static defaultManifestPreprocessorTXml(element: XmlNode) {
    return ConfigUtils.referenceParametersAndReturn([element], element);
  }
}
