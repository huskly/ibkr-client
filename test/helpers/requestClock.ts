/** A scheduler clock that advances without wall-clock waits. */
export function createRequestClock() {
  let clock = 0;
  return {
    now: () => clock,
    sleep: (ms: number): Promise<void> => {
      clock += ms;
      return Promise.resolve();
    },
    advance: (ms: number): void => {
      clock += ms;
    },
  };
}
