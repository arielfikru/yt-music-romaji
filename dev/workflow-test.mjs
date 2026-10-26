import assert from "node:assert/strict";
import { mock } from "node:test";

let storage = { claudeKey: "fake-test-key" };
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: "0.6.0" }) },
  storage: { local: {
    async get(key) { return structuredClone(key === null ? storage : { [key]: storage[key] }); },
    async set(entries) { Object.assign(storage, structuredClone(entries)); },
    async remove(keys) { for (const key of keys) delete storage[key]; },
  } },
};
const names = { "鏡音リン": "Kagamine Rin", "25時、ナイトコードで。": "25-ji, Nightcord de.", "初音ミク": "Hatsune Miku" };
const apiCalls = [];
const searches = [];
const ownLrc = "[00:01.00]朝の窓を開ける\n[00:03.00]机に本を置く";
const row = { id: 1, trackName: "D/N/A", artistName: "Azari", duration: 133, syncedLyrics: ownLrc, plainLyrics: "朝の窓を開ける\n机に本を置く" };
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://lrclib.net/")) {
    const query = Object.fromEntries(new URL(url).searchParams);
    searches.push(query);
    return Response.json(query.track_name === "D/N/A" ? [row] : []);
  }
  const body = JSON.parse(init.body);
  apiCalls.push(body);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const payload = body.output_config.format.schema.properties.romanizations
    ? { romanizations: JSON.parse(body.messages[0].content).texts.map((original) => ({ original, text: names[original] || `Name ${original}` })) }
    : { lookups: [{ title: "D/N/A", artist: "Azari" }] };
  return Response.json({ id: "test", type: "message", role: "assistant", model: "test", stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify(payload) }], usage: { input_tokens: 1, output_tokens: 1 } });
};
const claude = await import("../src/claude.js");
const first = await claude.romanizeMetadata({ texts: ["鏡音リン", "鏡音リン", "25時、ナイトコードで。"] });
assert.deepEqual(first.romanizations, [{ original: "鏡音リン", text: "Kagamine Rin" }, { original: "25時、ナイトコードで。", text: "25-ji, Nightcord de." }]);
assert.equal(apiCalls.length, 1);
await claude.romanizeMetadata({ texts: ["鏡音リン"] });
assert.equal(apiCalls.length, 1);
// A new worker/module still reuses the persistent result.
const restarted = await import("../src/claude.js?new-worker");
await restarted.romanizeMetadata({ texts: ["鏡音リン"] });
assert.equal(apiCalls.length, 1);
await Promise.all([
  claude.romanizeMetadata({ texts: ["初音ミク", "名前一"] }),
  claude.romanizeMetadata({ texts: ["初音ミク", "名前二"] }),
]);
assert.equal(apiCalls.flatMap((c) => JSON.parse(c.messages[0].content).texts).filter((t) => t === "初音ミク").length, 1);
const exported = await claude.cacheEntries();
assert.equal(Object.keys(exported).filter((k) => k.startsWith("name:")).length, 5);
await claude.clearCache();
assert.deepEqual(await claude.cacheEntries(), {});
await claude.importCache(exported);
const beforeImport = apiCalls.length;
await claude.romanizeMetadata({ texts: ["鏡音リン"] });
assert.equal(apiCalls.length, beforeImport);
console.log("per-name durable cache, cross-worker reuse, shared in-flight calls and export/import passed");

const { findLyrics } = await import("../src/lookup.js");
const stages = [];
const cover = { title: "D/N/A / 25時、ナイトコードで。 × 鏡音リン", artist: "プロジェクトセカイ", duration: 130 };
const result = await findLyrics(cover, false, { onProgress: (p) => stages.push(p) });
assert.deepEqual(result, { plain: row.plainLyrics });
assert.deepEqual([...new Set(stages.map((p) => p.label))], ["Mencari di LRCLIB", "Parsing judul & artis dengan Haiku", "Mencari judul & artis asli di LRCLIB"]);
assert.ok(stages.every((p) => p.deadline > p.startedAt && p.next));
assert.ok(searches.some((q) => q.track_name === "D/N/A" && q.artist_name === "Azari"));
assert.ok(searches.every((q) => !["D", "N", "A"].includes(q.track_name)));
const beforeReuse = [apiCalls.length, searches.length];
await findLyrics(cover, false);
assert.deepEqual([apiCalls.length, searches.length], beforeReuse);
await findLyrics({ ...cover, duration: 129 }, false);
assert.equal(apiCalls.length, beforeReuse[0]); // parsed original artist is persisted
console.log("cover -> Haiku original artist -> LRCLIB, live stages, plain timing and cache passed");

// Advance real stage deadlines without waiting 24 seconds; stalled network work
// must abort and move through the cached Haiku lookup to the final search stage.
const realFetch = globalThis.fetch;
const timeoutStages = [];
let abortedSearches = 0;
globalThis.fetch = async (_url, init) => new Promise((_, reject) => {
  init.signal.addEventListener("abort", () => { abortedSearches++; reject(new Error("aborted")); }, { once: true });
});
mock.timers.enable({ apis: ["setTimeout", "Date"] });
try {
  const stalled = findLyrics({ ...cover, duration: 128 }, false, { onProgress: (p) => timeoutStages.push(p.label) });
  await new Promise(setImmediate);
  mock.timers.tick(12_000);
  await new Promise(setImmediate);
  assert.ok(timeoutStages.includes("Parsing judul & artis dengan Haiku"));
  assert.ok(timeoutStages.includes("Mencari judul & artis asli di LRCLIB"));
  mock.timers.tick(12_000);
  assert.deepEqual(await stalled, {});
  assert.equal(abortedSearches, 2);
} finally { mock.timers.reset(); globalThis.fetch = realFetch; }
console.log("stalled LRCLIB requests abort at deadlines and advance stages passed");

const { romanizeTitle, resetNameCache } = await import("../src/name-client.js");
let batches = [];
chrome.runtime.sendMessage = async ({ texts }) => {
  batches.push(texts);
  return { romanizations: texts.map((original) => ({ original, text: names[original] || `Latin ${original}` })) };
};
const inputs = Array.from({ length: 45 }, (_, i) => `名前${i}`);
await Promise.all([...inputs, ...inputs].map(romanizeTitle));
assert.deepEqual(batches.map((b) => b.length), [20, 20, 5]);
await Promise.all(inputs.map(romanizeTitle));
assert.equal(batches.length, 3);
assert.equal(await romanizeTitle("  鏡音リン  "), "  Kagamine Rin  ");
resetNameCache();
let failures = 0;
chrome.runtime.sendMessage = async () => { failures++; throw new Error("offline"); };
assert.equal(await romanizeTitle("未知の名前"), "未知の名前");
assert.equal(await romanizeTitle("未知の名前"), "未知の名前");
assert.equal(failures, 1);
console.log("name batching, repeated DOM scans, whitespace and no retry storm passed");

// DOM nodes can be recycled or titles switched off before the name request resolves.
resetNameCache();
globalThis.NodeFilter = { SHOW_TEXT: 4 };
const element = { title: "", removeAttribute() { this.title = ""; } };
const node = { nodeValue: "鏡音リン", isConnected: true, parentElement: { closest: () => element } };
globalThis.document = {
  querySelectorAll: () => [element],
  createTreeWalker() { let seen = false; return { nextNode() { if (seen) return null; seen = true; return node; } }; },
};
chrome.runtime.sendMessage = async ({ texts }) => ({ romanizations: texts.map((original) => ({ original, text: names[original] })) });
const titles = await import("../src/titles.js");
await titles.romanizeTitles();
assert.equal(node.nodeValue, "Kagamine Rin");
assert.equal(titles.originalText(element), "鏡音リン");
titles.restoreTitles();
assert.equal(node.nodeValue, "鏡音リン");
resetNameCache();
const waiting = titles.romanizeTitles();
node.nodeValue = "Another track";
await waiting;
assert.equal(node.nodeValue, "Another track");
node.nodeValue = "鏡音リン";
resetNameCache();
const disabled = titles.romanizeTitles();
titles.restoreTitles();
await disabled;
assert.equal(node.nodeValue, "鏡音リン");
console.log("original metadata preservation, recycled nodes and disabled-title race passed");

const { progressText, runWorkerTask } = await import("../src/job-client.js");
const progress = { label: "Claude · Poetic", startedAt: 1000, deadline: 91000, next: "Penerjemah lokal", completed: 3, total: 40 };
assert.match(progressText(progress, 11000), /10 dtk · 3\/40 baris/);
assert.match(progressText(progress, 11000), /80 dtk lagi/);
assert.match(progressText(progress, 92000), /Beralih/);
assert.doesNotMatch(progressText(progress, 92000), /-\d/);
let disconnected = 0;
chrome.runtime.connect = () => {
  let onMessage;
  return {
    onMessage: { addListener(fn) { onMessage = fn; } }, onDisconnect: { addListener() {} },
    disconnect() { disconnected++; },
    postMessage() { queueMicrotask(() => { onMessage({ type: "progress", progress }); onMessage({ type: "result", result: { ok: true } }); }); },
  };
};
const delivered = [];
assert.deepEqual(await runWorkerTask("claude-translate", {}, (p) => delivered.push(p)), { ok: true });
assert.equal(delivered.length, 1);
assert.equal(disconnected, 1);
const abort = new AbortController(); abort.abort();
await assert.rejects(runWorkerTask("find-lyrics", {}, () => {}, abort.signal), /cancelled/);
console.log("live elapsed/countdown formatting, progress port delivery and cancellation passed");
