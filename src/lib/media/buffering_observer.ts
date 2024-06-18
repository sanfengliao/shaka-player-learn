/**
 * The buffering observer watches how much content has been buffered and raises
 * events when the state changes (enough => not enough or vice versa).
 */
export class BufferingObserver {
  private previousState_: BufferingObserverState;
  private thresholds_: Map<BufferingObserverState, number>;
  private lastRebufferTime_: number;
  constructor(thresholdWhenStarving: number, thresholdWhenSatisfied: number) {
    this.previousState_ = BufferingObserverState.SATISFIED;

    this.thresholds_ = new Map()
      .set(BufferingObserverState.SATISFIED, thresholdWhenSatisfied)
      .set(BufferingObserverState.STARVING, thresholdWhenStarving);
    this.lastRebufferTime_ = 0;
  }

  setThresholds(thresholdWhenStarving: number, thresholdWhenSatisfied: number) {
    this.thresholds_
      .set(BufferingObserverState.SATISFIED, thresholdWhenSatisfied)
      .set(BufferingObserverState.STARVING, thresholdWhenStarving);
  }

  /**
   * Update the observer by telling it how much content has been buffered (in
   * seconds) and if we are buffered to the end of the presentation. If the
   * controller believes the state has changed, it will return |true|.
   *
   * @param bufferLead
   * @param bufferedToEnd
   */
  update(bufferLead: number, bufferedToEnd: boolean) {
    /**
     * Our threshold for how much we need before we declare ourselves as
     * starving is based on whether or not we were just starving. If we
     * were just starving, we are more likely to starve again, so we require
     * more content to be buffered than if we were not just starving.
     */
    const threshold = this.thresholds_.get(this.previousState_)!;

    const oldState = this.previousState_;

    const newState =
      bufferedToEnd || bufferLead >= threshold ? BufferingObserverState.SATISFIED : BufferingObserverState.STARVING;

    // Save the new state now so that calls to |getState| from any callbacks
    // will be accurate.
    this.previousState_ = newState;

    const stateChanged = oldState !== newState;

    if (stateChanged && newState === BufferingObserverState.SATISFIED) {
      this.lastRebufferTime_ = Date.now();
    }

    return stateChanged;
  }

  /**
   * Set which state that the observer should think playback was in.
   *
   * @param state
   */
  setState(state: BufferingObserverState) {
    this.previousState_ = state;
  }

  getState() {
    return this.previousState_;
  }

  /**
   * Return the last time that the state went from |STARVING| to |SATISFIED|.
   */
  getLastRebufferTime() {
    return this.lastRebufferTime_;
  }

  /**
   * Reset the last rebuffer time to zero.
   */
  resetLastRebufferTime() {
    this.lastRebufferTime_ = 0;
  }
}

export const enum BufferingObserverState {
  STARVING = 0,
  SATISFIED = 1,
}
