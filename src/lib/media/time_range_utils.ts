import { BufferedRange } from '../../externs/shaka';

export class TimeRangesUtils {
  /**
   *
   * @param b Determines if the given time is inside a gap between buffered ranges.  If
   * it is, this returns the index of the buffer that is *ahead* of the gap
   * @param time
   * @param threshold
   */
  static getGapIndex(b: TimeRanges, time: number, threshold: number) {
    if (!b || !b.length) {
      return null;
    }
    // Workaround Safari bug: https://bit.ly/2trx6O8
    if (b.length == 1 && b.end(0) - b.start(0) < 1e-6) {
      return null;
    }

    const idx = TimeRangesUtils.getBufferedInfo(b).findIndex((item, i, arr) => {
      // currentBufferStartTime > time && lastBufferEndTime < time
      return item.start > time && (i == 0 || arr[i - 1].end - time <= threshold);
    });
    return idx >= 0 ? idx : null;
  }
  /**
   * Gets the first timestamp in the buffer.
   * @param b
   * @returns The first buffered timestamp, in seconds, if |buffered|
   *   is non-empty; otherwise, return null.
   */
  static bufferStart(b: TimeRanges | null) {
    if (!b) {
      return null;
    }
    if (b.length === 1 && b.end(0) - b.start(0) < 1e-6) {
      return null;
    }

    if (b.length === 1 && b.start(0) < 0) {
      return 0;
    }
    return b.length ? b.start(0) : null;
  }

  /**
   * Gets the last timestamp in the buffer.
   *
   * @param b
   * @return The last buffered timestamp, in seconds, if |buffered|
   *   is non-empty; otherwise, return null.
   */
  static bufferEnd(b: TimeRanges | null) {
    if (!b) {
      return null;
    }
    // Workaround Safari bug: https://bit.ly/2trx6O8
    if (b.length == 1 && b.end(0) - b.start(0) < 1e-6) {
      return null;
    }
    return b.length ? b.end(b.length - 1) : null;
  }

  /**
   * Determines if the given time is inside a buffered range.
   *
   * @param {TimeRanges} b
   * @param {number} time Playhead time
   * @return {boolean}
   */
  static isBuffered(b: TimeRanges | null, time: number) {
    if (!b || !b.length) {
      return false;
    }
    // Workaround Safari bug: https://bit.ly/2trx6O8
    if (b.length == 1 && b.end(0) - b.start(0) < 1e-6) {
      return false;
    }

    if (time > b.end(b.length - 1)) {
      return false;
    }

    return time >= b.start(0);
  }

  /**
   * Computes how far ahead of the given timestamp is buffered.  To provide
   * smooth playback while jumping gaps, we don't include the gaps when
   * calculating this.
   * This only includes the amount of content that is buffered.
   * @param b
   * @param time
   * @returns The number of seconds buffered, in seconds, ahead of the given time.
   */
  static bufferedAheadOf(b: TimeRanges | null, time: number) {
    if (!b || !b.length) {
      return 0;
    }
    // Workaround Safari bug: https://bit.ly/2trx6O8
    if (b.length == 1 && b.end(0) - b.start(0) < 1e-6) {
      return 0;
    }

    // We calculate the buffered amount by ONLY accounting for the content
    // buffered (i.e. we ignore the times of the gaps).  We also buffer through
    // all gaps.
    // Therefore, we start at the end and add up all buffers until |time|.

    let result = 0;
    for (const { start, end } of TimeRangesUtils.getBufferedInfo(b)) {
      if (end > time) {
        result += end - Math.max(start, time);
      }
    }
    return result;
  }

  static getBufferedInfo(b: TimeRanges | null): BufferedRange[] {
    if (!b) {
      return [];
    }
    const ret: BufferedRange[] = [];
    for (let i = 0; i < b.length; i++) {
      ret.push({
        start: b.start(i),
        end: b.end(i),
      });
    }

    return ret;
  }

  /**
   *  This operation can be potentially EXPENSIVE and should only be done in
   * debug builds for debugging purposes.
   * @param oldRanges
   * @param newRanges
   * @returns  The last added range,
   *   chronologically by presentation time.
   */
  static computeAddedRange(oldRanges: TimeRanges | null, newRanges: TimeRanges | null) {
    if (!oldRanges || !oldRanges.length) {
      return null;
    }
    if (!newRanges || !newRanges.length) {
      return TimeRangesUtils.getBufferedInfo(newRanges).pop();
    }
    const newRangesReversed = TimeRangesUtils.getBufferedInfo(newRanges).reverse();
    const oldRangesReversed = TimeRangesUtils.getBufferedInfo(oldRanges).reverse();
    for (const newRange of newRangesReversed) {
      let foundOverlap = false;

      for (const oldRange of oldRangesReversed) {
        if (oldRange.end >= newRange.start && oldRange.end <= newRange.end) {
          foundOverlap = true;

          // If the new range goes beyond the corresponding old one, the
          // difference is newly-added.
          if (newRange.end > oldRange.end) {
            return { start: oldRange.end, end: newRange.end };
          }
        }
      }

      if (!foundOverlap) {
        return newRange;
      }
    }

    return null;
  }
}
