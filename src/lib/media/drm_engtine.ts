import { DrmInfo } from '../../externs/shaka/manifest';
import { IDestroyable } from '../util/i_destroyable';

/**
 * TODO(sanfeng): 实现DRM
 */
export class DrmEngine implements IDestroyable {
  static areDrmCompatible(drms1: DrmInfo[], drms2: DrmInfo[]) {
    if (!drms1.length || !drms2.length) {
      return true;
    }

    if (drms1 === drms2) {
      return true;
    }

    return DrmEngine.getCommonDrmInfos(drms1, drms2).length > 0;
  }
  destroy(): Promise<void> {
    throw new Error('Method not implemented.');
  }

  /**
   * Returns an array of drm infos that are present in both input arrays.
   * If one of the arrays is empty, returns the other one since clear
   * content is considered compatible with every drm info.
   *
   * @param drms1
   * @param drms2
   */
  static getCommonDrmInfos(drms1: DrmInfo[], drms2: DrmInfo[]): DrmInfo[] {
    if (!drms1.length) {
      return drms2;
    }
    if (!drms2.length) {
      return drms1;
    }
    const commonDrms: DrmInfo[] = [];
    for (const drm1 of drms1) {
      for (const drm2 of drms2) {
        if (drm1.keySystem == drm2.keySystem) {
          const initDataMap = new Map();
          const bothInitDatas = (drm1.initData || []).concat(drm2.initData || []);
          for (const d of bothInitDatas) {
            initDataMap.set(d.keyId, d);
          }
          const initData = Array.from(initDataMap.values());

          const keyIds =
            drm1.keyIds && drm2.keyIds ? new Set([...drm1.keyIds, ...drm2.keyIds]) : drm1.keyIds || drm2.keyIds;
          const mergedDrm: DrmInfo = {
            keySystem: drm1.keySystem,
            licenseServerUri: drm1.licenseServerUri || drm2.licenseServerUri,
            distinctiveIdentifierRequired: drm1.distinctiveIdentifierRequired || drm2.distinctiveIdentifierRequired,
            persistentStateRequired: drm1.persistentStateRequired || drm2.persistentStateRequired,
            videoRobustness: drm1.videoRobustness || drm2.videoRobustness,
            audioRobustness: drm1.audioRobustness || drm2.audioRobustness,
            serverCertificate: drm1.serverCertificate || drm2.serverCertificate,
            serverCertificateUri: drm1.serverCertificateUri || drm2.serverCertificateUri,
            initData,
            keyIds,
          };
          commonDrms.push(mergedDrm);
          break;
        }
      }
    }
    return commonDrms;
  }
}
