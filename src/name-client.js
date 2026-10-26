import { hasJapanese } from "./romaji.js";

const resolved = new Map();
const pending = new Map();
const queue = new Map();
let running = false;
let timer;
let generation = 0;

async function flush() {
  if (running) return;
  running = true;
  try {
    while (queue.size) {
      const batch = [...queue.values()].slice(0, 20);
      for (const item of batch) queue.delete(item.text);
      let reply;
      try {
        reply = await chrome.runtime.sendMessage({ type: "claude-romanize-names", texts: batch.map((i) => i.text) });
      } catch { /* Leave original text on API/extension failures. */ }
      for (const item of batch) {
        if (item.generation !== generation) continue;
        const candidate = reply?.romanizations?.find((r) => r.original === item.text)?.text;
        const text = typeof candidate === "string" && candidate.trim() ? candidate.trim() : item.text;
        // Failed names also settle for this session; DOM mutations must not cause retry storms.
        resolved.set(item.text, text);
        pending.delete(item.text);
        item.resolve(text);
      }
    }
  } finally { running = false; }
}

export function romanizeTitle(original) {
  const [, lead, text, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(original);
  if (!hasJapanese(text) || text.length > 1000) return Promise.resolve(original);
  if (resolved.has(text)) return Promise.resolve(lead + resolved.get(text) + trail);
  if (!pending.has(text)) {
    const deferred = Promise.withResolvers();
    const item = { text, generation, ...deferred };
    pending.set(text, item);
    queue.set(text, item);
    clearTimeout(timer);
    timer = setTimeout(flush, 30);
  }
  return pending.get(text).promise.then((value) => lead + value + trail);
}

export function resetNameCache() {
  generation++;
  resolved.clear();
  for (const item of pending.values()) item.resolve(item.text);
  pending.clear();
  queue.clear();
  clearTimeout(timer);
}
