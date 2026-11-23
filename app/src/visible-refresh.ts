/** Read once on open, then refresh on invalidation, return to the page, or a missed push.
 * The caller owns the watcher's lifetime (e.g. while a tab is selected). */
export function watchVisibleRefresh<T>(
  load: (signal: AbortSignal) => Promise<T>,
  publish: (value: T) => void,
  subscribe: (invalidate: () => void) => () => void,
  isVisible: () => boolean,
) {
  const controller = new AbortController();
  const visible = () => !controller.signal.aborted && isVisible();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let running = false;

  function invalidate() {
    if (!visible()) return;
    pending = true;
    // Coalesce bursts without postponing the refresh indefinitely. Keep one trailing read if
    // anything changes during a request, and never let two responses arrive out of order.
    if (!running && timer === undefined) timer = setTimeout(refresh, 500);
  }

  async function refresh() {
    timer = undefined;
    if (!visible()) return;
    pending = false;
    running = true;
    try {
      const value = await load(controller.signal);
      if (visible()) publish(value);
    } catch {
      // Keep the last successful value; the next trigger will retry.
    } finally {
      running = false;
      if (pending) invalidate();
    }
  }

  const unsubscribe = subscribe(invalidate);
  const poll = setInterval(invalidate, 30_000);
  void refresh();
  return () => {
    controller.abort();
    clearTimeout(timer);
    clearInterval(poll);
    unsubscribe();
  };
}
