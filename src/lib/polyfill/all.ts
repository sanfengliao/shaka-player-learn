export interface Polyfill {
  priority: number;
  callback: Function;
}

export const polyfill = {
  installAll() {
    for (const polyfill of this.polyfills_) {
      polyfill.callback();
    }
  },
  /**
   * Registers a new polyfill to be installed.
   * @param polyfill
   * @param priority  An optional number priority.  Higher priorities
   *   will be executed before lower priority ones.  Default is 0.
   */
  register(polyfill: Function, priority: number = 0) {
    const newItem = {
      priority,
      callback: polyfill,
    };
    for (let i = 0; i < this.polyfills_.length; i++) {
      if (this.polyfills_[i].priority < priority) {
        this.polyfills_.splice(i, 0, newItem);
        return;
      }
    }
    this.polyfills_.push(newItem);
  },
  polyfills_: [] as Polyfill[],
};
