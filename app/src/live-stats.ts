import { api, type Stats } from "./api";
import { onLive } from "./live";
import { onUploadReady } from "./uploads.svelte";
import { watchVisibleRefresh } from "./visible-refresh";

const localChanges = new Set<() => void>();
export const invalidateLiveStats = () => localChanges.forEach((invalidate) => invalidate());

export function watchLiveStats(publish: (stats: Stats) => void) {
  return watchVisibleRefresh(
    api.stats,
    publish,
    (invalidate) => {
      const offLive = onLive((e) => {
        if (e.t === "reconnect" || e.t === "meme" || (e.t === "job" && ["zip", "batch", "e621"].includes(e.kind))) invalidate();
      });
      const offUpload = onUploadReady(invalidate);
      localChanges.add(invalidate);
      window.addEventListener("focus", invalidate);
      window.addEventListener("online", invalidate);
      document.addEventListener("visibilitychange", invalidate);
      return () => {
        offLive();
        offUpload();
        localChanges.delete(invalidate);
        window.removeEventListener("focus", invalidate);
        window.removeEventListener("online", invalidate);
        document.removeEventListener("visibilitychange", invalidate);
      };
    },
    () => document.visibilityState === "visible",
  );
}
