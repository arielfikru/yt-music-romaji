// A port carries progress while the service worker performs a long request.
export function runWorkerTask(type, payload, onProgress = () => {}, signal) {
  if (!chrome.runtime.connect) return chrome.runtime.sendMessage({ type, ...payload });
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "romaji-job" });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      port.disconnect();
      error ? reject(error) : resolve(result);
    };
    const cancel = () => finish(new Error("Request cancelled"));
    const timer = setTimeout(() => finish(new Error("Background task exceeded its time limit")), type === "claude-translate" ? 185_000 : 50_000);
    port.onMessage.addListener((message) => {
      if (message.type === "progress") onProgress(message.progress);
      else if (message.type === "result") finish(null, message.result);
    });
    port.onDisconnect.addListener(() => finish(new Error(chrome.runtime.lastError?.message || "Background worker disconnected; reload the extension and refresh this tab")));
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) return cancel();
    port.postMessage({ type, ...payload });
  });
}

export function progressText(progress, now = Date.now()) {
  const elapsed = Math.max(0, Math.floor((now - progress.startedAt) / 1000));
  const count = Number.isFinite(progress.total) ? ` · ${progress.completed ?? 0}/${progress.total} baris` : "";
  const remaining = Math.max(0, Math.ceil((progress.deadline - now) / 1000));
  const next = Number.isFinite(progress.deadline)
    ? ` · ${remaining ? `${progress.next}: maks. ${remaining} dtk lagi` : `Beralih ke ${progress.next}…`}` : "";
  return `${progress.label} · ${elapsed} dtk${count}${next}`;
}

export async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
