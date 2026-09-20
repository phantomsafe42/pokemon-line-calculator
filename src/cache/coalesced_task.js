// Collapse duplicate calls in one event without adding a timer or delaying
// durable saves until idle. All callers await the same resulting operation.
export function coalescedTask(run) {
  let pending = null;
  return () => {
    if (!pending) pending = Promise.resolve().then(() => {
      pending = null;
      return run();
    });
    return pending;
  };
}
