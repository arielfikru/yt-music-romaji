import { cacheEntries, checkKey, clearCache, importCache, retranslateLine, romanizeMetadata, translateWithClaude } from "./claude.js";
import { clearLookupCache, findLyrics } from "./lookup.js";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    "find-synced-lyrics": () => findLyrics(msg, true),
    "find-lyrics": () => findLyrics(msg, false),
    "claude-romanize-names": () => romanizeMetadata(msg),
    "claude-translate": () => translateWithClaude(msg),
    "claude-retranslate-line": () => retranslateLine(msg),
    "claude-check-key": () => checkKey(msg.key),
    "claude-cache-export": () => cacheEntries().then((entries) => ({ entries })),
    "claude-cache-import": () => importCache(msg.entries).then((count) => ({ count })),
    "claude-cache-clear": () => clearCache().then(() => (clearLookupCache(), {})),
  };
  const job = handlers[msg?.type]?.();
  if (!job) return;
  job.then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true; // keeps the channel open for the async reply
});

// Long-lived connections carry real stage changes while requests are in progress.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "romaji-job") return;
  const controller = new AbortController();
  let started = false;
  const send = (message) => { try { port.postMessage(message); } catch { /* Tab closed. */ } };
  port.onDisconnect.addListener(() => controller.abort());
  port.onMessage.addListener(async (msg) => {
    if (started) return;
    started = true;
    const options = { signal: controller.signal, onProgress: (progress) => send({ type: "progress", progress }) };
    try {
      let result;
      if (msg.type === "claude-translate") result = await translateWithClaude(msg, options);
      else if (msg.type === "claude-retranslate-line") result = await retranslateLine(msg, options);
      else if (["find-lyrics", "find-synced-lyrics"].includes(msg.type)) result = await findLyrics(msg, msg.type === "find-synced-lyrics", options);
      else result = { error: "Unknown background task" };
      send({ type: "result", result });
    } catch (e) { send({ type: "result", result: { error: String(e?.message ?? e) } }); }
  });
});
