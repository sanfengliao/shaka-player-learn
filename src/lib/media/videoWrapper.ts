import { asserts } from '../debug/asserts';
import { log } from '../debug/log';
import { EventManager } from '../util/event_manager';
import { IReleasable } from '../util/i_releasable';
import { MediaReadyState } from '../util/media_ready_state_utils';
import { Timer } from '../util/timer';

/**
 * Creates a new VideoWrapper that manages setting current time and playback
 * rate.  This handles seeks before content is loaded and ensuring the video
 * time is set properly.  This doesn't handle repositioning within the
 * presentation window.
 *
 * @implements {shaka.util.IReleasable}
 */
export class VideoWrapper implements IReleasable {
  private video_: HTMLMediaElement;
  private onSeek_: () => void;
  private onStarted_: (time: number) => void;
  private startTime_: number | null;
  private getStartTime_: () => number;
  private started_: boolean;
  private eventManager_: EventManager;
  private mover_: PlayheadMover;
  /**
   * @param {!HTMLMediaElement} video
   * @param {function()} onSeek Called when the video seeks.
   * @param {function(number)} onStarted Called when the video has started.
   * @param {function():number} getStartTime Calle to get the time to start at.
   */
  constructor(
    video: HTMLMediaElement,
    onSeek: () => void,
    onStarted: (time: number) => void,
    getStartTime: () => number
  ) {
    this.video_ = video;

    this.onSeek_ = onSeek;

    this.onStarted_ = onStarted;

    this.startTime_ = null;

    this.getStartTime_ = () => {
      if (this.startTime_ === null) {
        this.startTime_ = getStartTime();
      }
      return this.startTime_;
    };

    this.started_ = false;

    this.eventManager_ = new EventManager();

    this.mover_ = new PlayheadMover(/* mediaElement= */ video, /* maxAttempts= */ 10);

    // Before we can set the start time, we must check if the video element is
    // ready. If the video element is not ready, we cannot set the time. To work
    // around this, we will wait for the "loadedmetadata" event which tells us
    // that the media element is now ready.
    MediaReadyState.waitForReadyState(this.video_, HTMLMediaElement.HAVE_METADATA, this.eventManager_, () => {
      this.setStartTime_(this.getStartTime_());
    });
  }

  release() {
    if (this.eventManager_) {
      this.eventManager_.release();
      this.eventManager_ = null as any;
    }

    if (this.mover_ != null) {
      this.mover_.release();
      this.mover_ = null as any;
    }

    this.onSeek_ = () => {};
    this.video_ = null as any;
  }

  /**
   * Gets the video's current (logical) position.
   *
   * @return {number}
   */
  getTime() {
    return this.started_ ? this.video_.currentTime : this.getStartTime_();
  }

  /**
   * Sets the current time of the video.
   *
   * @param  time
   */
  setTime(time: number) {
    if (this.video_.readyState > 0) {
      this.mover_.moveTo(time);
    } else {
      MediaReadyState.waitForReadyState(this.video_, HTMLMediaElement.HAVE_METADATA, this.eventManager_, () => {
        this.setStartTime_(this.getStartTime_());
      });
    }
  }

  /**
   * Set the start time for the content. The given start time will be ignored if
   * the content does not start at 0.
   *
   * @param  startTime
   */
  private setStartTime_(startTime: number) {
    // If we start close enough to our intended start time, then we won't do
    // anything special.
    if (Math.abs(this.video_.currentTime - startTime) < 0.001) {
      this.startListeningToSeeks_();
      return;
    }

    // We will need to delay adding our normal seeking listener until we have
    // seen the first seek event. We will force the first seek event later in
    // this method.
    this.eventManager_.listenOnce(this.video_, 'seeking', () => {
      this.startListeningToSeeks_();
    });

    // If the currentTime != 0, it indicates that the user has seeked after
    // calling |Player.load|, meaning that |currentTime| is more meaningful than
    // |startTime|.
    //
    // Seeking to the current time is a work around for Issue 1298 and 4888.
    // If we don't do this, the video may get stuck and not play.
    //
    // TODO: Need further investigation why it happens. Before and after
    // setting the current time, video.readyState is 1, video.paused is true,
    // and video.buffered's TimeRanges length is 0.
    // See: https://github.com/shaka-project/shaka-player/issues/1298
    this.mover_.moveTo(!this.video_.currentTime || this.video_.currentTime == 0 ? startTime : this.video_.currentTime);
  }

  /**
   * Add the listener for seek-events. This will call the externally-provided
   * |onSeek| callback whenever the media element seeks.
   */
  private startListeningToSeeks_() {
    asserts.assert(this.video_.readyState > 0, 'The media element should be ready before we listen for seeking.');

    // Now that any startup seeking is complete, we can trust the video element
    // for currentTime.
    this.started_ = true;

    this.eventManager_.listen(this.video_, 'seeking', () => this.onSeek_());
    this.onStarted_(this.video_.currentTime);
  }
}

/**
 * A class used to move the playhead away from its current time.  Sometimes,
 * legacy Edge ignores re-seeks. After changing the current time, check every
 * 100ms, retrying if the change was not accepted.
 *
 * Delay stats over 100 runs of a re-seeking integration test:
 *   Edge   -   0ms -   2%
 *   Edge   - 100ms -  40%
 *   Edge   - 200ms -  32%
 *   Edge   - 300ms -  24%
 *   Edge   - 400ms -   2%
 *   Chrome -   0ms - 100%
 *
 * Unfortunately, legacy Edge is not receiving updates anymore, but it still
 * must be supported as it is used for web browsers on XBox.
 *
 * @implements {shaka.util.IReleasable}
 * @final
 */
class PlayheadMover implements IReleasable {
  private remainingAttempts_ = 0;

  private originTime_ = 0;

  private targetTime_ = 0;

  private timer_ = new Timer(() => this.onTick_());
  private mediaElement_: HTMLMediaElement;
  private maxAttempts_: number;
  /**
   * @param mediaElement
   *    The media element that the mover can manipulate.
   *
   * @param maxAttempts
   *    To prevent us from infinitely trying to change the current time, the
   *    mover accepts a max attempts value. At most, the mover will check if the
   *    video moved |maxAttempts| times. If this is zero of negative, no
   *    attempts will be made.
   */
  constructor(mediaElement: HTMLMediaElement, maxAttempts: number) {
    this.mediaElement_ = mediaElement;

    this.maxAttempts_ = maxAttempts;
  }

  release() {
    if (this.timer_) {
      this.timer_.stop();
      this.timer_ = null as any;
    }

    this.mediaElement_ = null as any;
  }

  /**
   * Try forcing the media element to move to |timeInSeconds|. If a previous
   * call to |moveTo| is still in progress, this will override it.
   *
   * @param timeInSeconds
   */
  moveTo(timeInSeconds: number) {
    this.originTime_ = this.mediaElement_.currentTime;
    this.targetTime_ = timeInSeconds;

    this.remainingAttempts_ = this.maxAttempts_;

    // Set the time and then start the timer. The timer will check if the set
    // was successful, and retry if not.
    this.mediaElement_.currentTime = timeInSeconds;
    this.timer_.tickEvery(/* seconds= */ 0.1);
  }

  /**
   * 检查是否seek成功
   */
  onTick_() {
    // Sigh... We ran out of retries...
    if (this.remainingAttempts_ <= 0) {
      log.warning(['Failed to move playhead from', this.originTime_, 'to', this.targetTime_].join(' '));

      this.timer_.stop();
      return;
    }

    // Yay! We were successful.
    if (this.mediaElement_.currentTime != this.originTime_) {
      this.timer_.stop();
      return;
    }

    // Sigh... Try again...
    this.mediaElement_.currentTime = this.targetTime_;
    this.remainingAttempts_--;
  }
}
