import { FakeEventTarget } from '../util/fake_event_target';
import { IDestroyable } from '../util/i_destroyable';

export class PreloadManager extends FakeEventTarget implements IDestroyable {
  private assetUri_: string;
  private mimeType_: string;
  private startTime_: number;
  private startTimeOfLoad_: number;

  constructor(
    assetUri: string,
    mimeType: string,
    startTimeOfLoad: number,
    startTime: number
  ) {
    super();
    this.assetUri_ = assetUri;
    this.startTime_ = startTime;
    this.startTimeOfLoad_ = startTimeOfLoad;
    this.mimeType_ = mimeType;
  }
  /**
   * TODO implement destroy
   */
  async destroy(): Promise<void> {
    throw new Error('Method not implemented.');
  }

  getAssetUri() {
    return this.assetUri_;
  }

  getStartTime() {
    return this.startTime_;
  }

  getMimeType() {
    return this.mimeType_;
  }
}
