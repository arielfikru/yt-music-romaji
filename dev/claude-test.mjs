import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// All requests are intercepted: no browser data, API key or network is used.
let storage = { claudeKey: "test-key" };
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: "0.6.0" }) },
  storage: {
    local: {
      async get(key) { return structuredClone(key === null ? storage : { [key]: storage[key] }); },
      async set(values) { Object.assign(storage, structuredClone(values)); },
      async remove(keys) { for (const key of keys) delete storage[key]; },
    },
    onChanged: { addListener() {} },
  },
};
const { statusForVersion, statusText } = await import("../static/claude-status.js");
const legacyStatus = { ok: false, message: "Claude translated only 1 of 72 lines" };
const stale = statusForVersion(legacyStatus, "0.6.0");
assert.equal(stale.ok, null);
assert.match(statusText(stale), /older version/);
assert.doesNotMatch(statusText(stale), /✕|1 of 72/);
const fresh = { ok: false, message: "Invalid API key", version: "0.6.0" };
assert.deepEqual(statusForVersion(fresh, "0.6.0"), fresh);
assert.equal(statusText(fresh), "✕ Invalid API key");
assert.equal(statusText({ ok: null, message: "Translating…" }), "Translating…");
console.log("stale status migration and current error visibility passed");
let calls = [];
let active = 0;
let peak = 0;
const answer = (text, stop = "end_turn") => ({
  id: "test", type: "message", role: "assistant", model: "test",
  content: [{ type: "text", text: JSON.stringify({ translation: text }) }],
  stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 },
});
let respond = (text) => answer(`translated:${text}`);
globalThis.fetch = async (_url, init) => {
  const request = JSON.parse(init.body);
  assert.equal(storage.claudeStatus.phase, "working");
  assert.equal(storage.claudeStatus.version, "0.6.0");
  calls.push(request);
  peak = Math.max(peak, ++active);
  await new Promise((resolve) => setTimeout(resolve, 3));
  try {
    const result = respond(JSON.parse(request.messages[0].content).text);
    return result instanceof Response ? result : Response.json(result);
  } finally { active--; }
};
const { translateWithClaude, retranslateLine, cacheEntries, importCache, clearCache } = await import("../src/claude.js");
const translate = (lines, options = {}) => translateWithClaude({ lines, source: "ja", lang: "id", ...options });
const songKey = (lines) => "tr:id:" + createHash("sha256").update("ja\n" + lines.join("\n")).digest("hex");
const reset = () => {
  storage = { claudeKey: "test-key" }; calls = []; peak = 0;
  respond = (text) => answer(`translated:${text}`);
};

// Chorus at the beginning/middle/end: one request for each exact unique line.
const repeated = ["朝の窓を開ける", "机に本を置く", "朝の窓を開ける", "水を飲む", "朝の窓を開ける", "外へ歩く"];
storage.claudeStatus = legacyStatus;
storage.claudeLastBadAnswer = { at: 1792996583019, lines: 72 };
const liveProgress = [];
let result = await translateWithClaude({ lines: repeated, source: "ja", lang: "id", title: "Private title", artist: "Private artist" }, { onProgress: (p) => liveProgress.push(p) });
assert.deepEqual(result.translations, repeated.map((t) => `translated:${t}`));
assert.equal(calls.length, 4);
assert.equal(storage.claudeLastBadAnswer, undefined);
assert.equal(storage.claudeStatus.version, "0.6.0");
assert.equal(storage.claudeStatus.ok, true);
assert.ok(peak <= 3);
assert.equal(peak, 3);
assert.deepEqual(liveProgress.map((p) => p.completed), [0, 1, 2, 3, 4]);
assert.ok(liveProgress.every((p) => p.total === 4 && p.deadline - p.startedAt === 180_000));
assert.equal(liveProgress[1].translations.length, 1);
for (const request of calls) {
  assert.doesNotMatch(request.system, /lyrics|song|copyright/i);
  assert.equal(request.messages.length, 1);
  const input = JSON.parse(request.messages[0].content);
  assert.deepEqual(Object.keys(input), ["text", "before", "after"]);
  const first = repeated.indexOf(input.text);
  assert.deepEqual(input.before, repeated.slice(Math.max(0, first - 2), first));
  assert.deepEqual(input.after, repeated.slice(first + 1, first + 3));
  assert.doesNotMatch(JSON.stringify(request), /Private title|Private artist/);
}
storage.claudeStatus = legacyStatus;
result = await translate(repeated);
assert.equal(result.cached, true);
assert.equal(storage.claudeStatus.phase, "cached");
assert.equal(storage.claudeStatus.ok, null);
assert.match(storage.claudeStatus.message, /No API call/);
assert.equal(calls.length, 4);
// Different order / a different song still reuses each line from persistent storage.
await translate([repeated[3], repeated[0]], { title: "Another title" });
assert.equal(calls.length, 4);
// Same text in another style or language must have its own entry.
for (const style of ["singable", "poetic"]) {
  await translate([repeated[0]], { style });
  assert.doesNotMatch(calls.at(-1).system, /lyrics|song|copyright/i);
  if (style === "singable") {
    assert.match(calls.at(-1).system, /singable adaptation/);
    assert.doesNotMatch(calls.at(-1).system, /Never stiff or formal|words like gak|a short phrase stays a short phrase/);
  }
}
await translate([repeated[0]], { lang: "en" });
await translate([repeated[0]], { source: "ko" });
assert.equal(calls.length, 8);
console.log("bounded neighboring context, first-occurrence reuse and single-target requests passed");
console.log("per-line prompts, duplicate reuse, persistent cache and style/language separation passed");

reset();
await Promise.all([translate(["共有", "一"]), translate(["共有", "二"])]);
assert.equal(calls.filter((r) => JSON.parse(r.messages[0].content).text === "共有").length, 1);
console.log("concurrent songs share in-flight line requests passed");

reset();
const old = ["古い記録", "新しい朝"];
storage[songKey(old)] = { declined: true, v: 2 };
assert.deepEqual((await translate(old)).translations, old.map((t) => `translated:${t}`));
assert.equal(calls.length, 2);
reset();
storage[songKey(old)] = { t: ["catatan lama", "pagi baru"], v: 2 };
assert.deepEqual((await translate(old)).translations, old.map((t) => `translated:${t}`));
assert.equal(calls.length, 2);
reset();
storage[songKey(old)] = { t: ["expanded old answer", "another old answer"], v: 3 };
const oldLineKey = "tr-line:id:" + createHash("sha256").update(JSON.stringify([3, "ja", "plain", old[0]])).digest("hex");
storage[oldLineKey] = { text: "expanded old line", v: 3 };
assert.deepEqual((await translate(old)).translations, old.map((t) => `translated:${t}`));
assert.equal(calls.length, 2);
console.log("old refusal and previous prompt song/line cache invalidation passed");

reset();
const singableKey = "tr:id:" + createHash("sha256").update("ja\nsingable\nそうだろう").digest("hex");
storage[singableKey] = { t: ["kan?"], v: 4 };
await translate(["そうだろう"], { style: "singable" });
assert.equal(calls.length, 1);
assert.equal(storage[singableKey].v, 5);
storage[songKey(old)] = { t: ["normal one", "normal two"], v: 4 };
assert.deepEqual((await translate(old)).translations, ["normal one", "normal two"]);
assert.equal(calls.length, 1);
console.log("only Translyrics refreshes after singing-prompt change; Normal cache retained");

reset();
respond = (text) => text === "拒否"
  ? answer("Maaf, aku tetap tidak bisa menerjemahkan lirik ini baris demi baris karena masih dilindungi hak cipta.")
  : text === "停止" ? answer("", "refusal") : answer("Aku tidak bisa tidur");
result = await translate(["拒否", "大丈夫", "拒否", "停止"]);
assert.deepEqual(result.translations, [null, "Aku tidak bisa tidur", null, null]);
assert.equal(result.declinedLines, 2);
assert.equal(calls.length, 3);
await translate(["停止", "拒否", "大丈夫"]);
assert.equal(calls.length, 3);
assert.ok(storage.claudeLastBadAnswer.content.every((b) => b.type === "text"));
console.log("JSON prose refusals, explicit refusals, repeated refusals and normal negative text passed");

reset();
respond = (text) => text === "壊れた" ? { ...answer(""), content: [{ type: "text", text: "not JSON" }] } : answer(`translated:${text}`);
result = await translate(["無事", "壊れた"]);
assert.deepEqual(result.translations, ["translated:無事", null]);
assert.ok(result.fallbackError);
respond = (text) => answer(`translated:${text}`);
result = await translate(["無事", "壊れた"]);
assert.deepEqual(result.translations, ["translated:無事", "translated:壊れた"]);
assert.equal(calls.length, 3); // successful line was retained; only broken line retried
console.log("malformed response isolation and retry without rebilling completed lines passed");

reset();
respond = (text) => text === "認証" ? Response.json({ type: "error", error: { type: "authentication_error", message: "invalid key" } }, { status: 401 }) : answer(`translated:${text}`);
result = await translate(["認証", "一", "二", "三", "四", "五"]);
assert.equal(calls.length, 3);
assert.equal(result.fallbackError, "Invalid API key");
assert.deepEqual(result.translations, [null, "translated:一", "translated:二", null, null, null]);
console.log("API failure stops the queue while retaining completed translations passed");

reset();
const song = ["前の行", "やり直し", "後の行"];
await translate(song, { style: "poetic" });
assert.equal(calls.length, 3);
assert.equal(calls[0].output_config.effort, "medium");
assert.match(calls[0].system, /verse/);
assert.doesNotMatch(calls[0].system, /lyrics|song|copyright/i);
respond = (text) => answer(`again:${text}`);
let line = await retranslateLine({ line: "やり直し", lines: song, source: "ja", lang: "id", style: "poetic", avoid: "translated:やり直し" });
assert.equal(line.text, "again:やり直し");
assert.equal(calls.length, 4);
const retryInput = JSON.parse(calls[3].messages[0].content);
assert.deepEqual(retryInput, { text: "やり直し", before: ["前の行"], after: ["後の行"], avoid: "translated:やり直し" });
result = await translate(song, { style: "poetic" });
assert.equal(calls.length, 4); // stale song dropped; rebuilt from saved lines without API calls
assert.deepEqual(result.translations, ["translated:前の行", "again:やり直し", "translated:後の行"]);
result = await translate(song, { style: "poetic", force: true });
assert.equal(calls.length, 7);
assert.deepEqual(result.translations, song.map((t) => `again:${t}`));
respond = () => answer("", "refusal");
line = await retranslateLine({ line: "拒否", lines: [], source: "ja", lang: "id" });
assert.equal(line.declined, true);
respond = (text) => answer(`translated:${text}`);
line = await retranslateLine({ line: "拒否", lines: [], source: "ja", lang: "id" });
assert.equal(line.text, "translated:拒否"); // a saved refusal does not block a retry
console.log("poetic prompt, single-line retry with avoid, and retry-all passed");

reset();
await translate(["保存", "再利用"]);
const exported = await cacheEntries();
assert.equal(Object.keys(exported).filter((k) => k.startsWith("tr-line:")).length, 2);
await clearCache();
assert.deepEqual(await cacheEntries(), {});
assert.equal(storage.claudeKey, "test-key");
assert.equal(await importCache(exported), 3);
await translate(["再利用"]);
assert.equal(calls.length, 2);
console.log("line cache export, import and clear passed");

// Content-side integration: a partial Claude reply must not let Nano overwrite good lines.
globalThis.self = globalThis;
let nanoPrompt;
globalThis.LanguageModel = {
  async availability() { return "available"; },
  async create() { return { async clone() { return {
    async prompt(prompt) { nanoPrompt = prompt; return JSON.stringify(["device translation"]); },
    destroy() {},
  }; } }; },
};
let sentStyle;
chrome.runtime = { ...chrome.runtime, async sendMessage(message) {
  sentStyle = message.style;
  return { translations: ["Claude translation", null], declinedLines: 1 };
} };
const tr = await import("../src/translate.js");
tr.setTranslationStyle("plain");
tr.translateSong(["成功", "不足"], "en");
const pending = [tr.translateLine("成功", "en"), tr.translateLine("不足", "en")];
tr.setTranslationStyle("poetic"); // changed while the asynchronous request is starting
const settled = await Promise.allSettled(pending);
assert.equal(settled[0].value, "Claude translation");
assert.equal(settled[1].status, "rejected"); // no on-device fill-in when Claude is on
assert.equal(sentStyle, "plain");
assert.equal(nanoPrompt, undefined);
tr.setTranslationStyle("plain");
assert.match(tr.translationSource("成功", "en"), /Claude/);
assert.doesNotMatch(tr.translationSource("成功", "en"), /Poetic|Nano/);
console.log("Claude-only translation leaves missing lines for retry, keeps in-flight style passed");

tr.resetTranslations();
let finishStream;
chrome.runtime.connect = () => {
  let listener;
  return {
    onMessage: { addListener(fn) { listener = fn; } }, onDisconnect: { addListener() {} }, disconnect() {},
    postMessage() {
      queueMicrotask(() => {
        const startedAt = Date.now();
        listener({ type: "progress", progress: { label: "Claude", startedAt, deadline: startedAt + 90_000,
          next: "Penerjemah lokal", completed: 1, total: 2, translations: [{ line: "早い", text: "early result" }] } });
      });
      finishStream = () => listener({ type: "result", result: { translations: ["early result", "later result"] } });
    },
  };
};
tr.translateSong(["早い", "遅い"], "en");
const early = tr.translateLine("早い", "en");
let lateDone = false;
const late = tr.translateLine("遅い", "en").then((value) => { lateDone = true; return value; });
assert.equal(await early, "early result");
assert.equal(lateDone, false);
finishStream();
assert.equal(await late, "later result");
console.log("completed translations display before the full request finishes passed");
