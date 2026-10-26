// Translation engines, best first:
// - Claude, when an API key is set in the popup: one line per request, with repeated lines reused (see claude.js).
// - English: Gemini Nano (Prompt API) translates the song in chunks with surrounding lines as context.
// - Indonesian, or when Gemini Nano is unavailable: Chrome's Translator API, line by line.
// The on-device engines also cover any song Claude fails on.

const translators = new Map(); // target language -> Promise<Translator>
const cache = new Map(); // lang + line -> Promise<string>
const sources = new Map(); // lang + line -> which engine translated it, shown on hover

// Whether a Claude API key is set; kept in sync so the toolbar can ask without awaiting.
let claudeOn = false;
// translateSong waits for this, so a song rendered right at page load doesn't miss the key.
const claudeLoaded = globalThis.chrome?.storage
  ? chrome.storage.local.get("claudeKey").then(({ claudeKey }) => (claudeOn = Boolean(claudeKey)))
  : Promise.resolve();
if (globalThis.chrome?.storage) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.claudeKey) claudeOn = Boolean(changes.claudeKey.newValue);
  });
}

// Claude's translation style ("plain", "singable", "poetic"), set from the popup setting.
// Part of every cache key, so switching style shows that style's saved translations.
let style = "plain";
const STYLE_LABEL = { plain: "", singable: ", Translyrics", poetic: ", Poetic" };
export const setTranslationStyle = (s) => (style = s || "plain");

// Forget translations made so far, e.g. on-device ones from before a Claude key was saved.
export const resetTranslations = () => (cache.clear(), sources.clear(), songStatus.clear());
export const usingClaude = () => claudeOn;

export const translatorSupported = () => claudeOn || "Translator" in self || "LanguageModel" in self;

// The translator mixes formal and casual pronouns line by line ("saya" here, "aku" there).
// Song lyrics read naturally in casual Indonesian, so make them all aku/kamu.
const PRONOUNS = { saya: "aku", anda: "kamu" };

export function normalizeIndonesian(text) {
  return text.replace(/\b(saya|anda)\b/gi, (word, _w, offset, whole) => {
    const repl = PRONOUNS[word.toLowerCase()];
    if (word.length > 1 && word === word.toUpperCase()) return repl.toUpperCase();
    const sentenceStart = /(^|[.!?…]\s*|["“(]\s*)$/.test(whole.slice(0, offset));
    return sentenceStart ? repl[0].toUpperCase() + repl.slice(1) : repl;
  });
}

// ---- Chrome Translator API ----

function ensureTranslator(lang, onProgress, source = "ja") {
  if (!("Translator" in self)) return Promise.reject(new Error("This Chrome has no built-in translator (needs Chrome 138+)"));
  const key = source + ">" + lang;
  if (!translators.has(key)) {
    const p = self.Translator.create({
      sourceLanguage: source,
      targetLanguage: lang,
      monitor: (m) => m.addEventListener("downloadprogress", (e) => onProgress?.(e.loaded)),
    });
    p.catch(() => translators.delete(key));
    translators.set(key, p);
  }
  return translators.get(key);
}

// ---- Gemini Nano (Prompt API) ----

const NANO_LANGS = { expectedInputs: [{ type: "text", languages: ["ja"] }], expectedOutputs: [{ type: "text", languages: ["en"] }] };
const SYSTEM_PROMPT = [
  "You translate Japanese song lyrics into natural, faithful English.",
  "Translate each numbered line on its own, but use the surrounding lines to work out who is speaking and what omitted subjects refer to.",
  "Keep pronouns consistent across the whole song (the singer is 'I', the person addressed is 'you').",
  "Keep the tone poetic and simple. Leave English words, names and sounds like 'la la' as they are.",
  "Output only the translations, never notes or explanations.",
].join(" ");
const CHUNK = 16; // lines per prompt; Gemini Nano gets unreliable with long JSON answers
const CONTEXT = 6; // earlier lines sent along as context

let nanoBase = null; // Promise<LanguageModel session> with the system prompt, cloned per chunk

async function nanoAvailability() {
  if (!("LanguageModel" in self)) return "unavailable";
  try {
    return await self.LanguageModel.availability(NANO_LANGS);
  } catch {
    return "unavailable";
  }
}

function ensureNano(onProgress) {
  nanoBase ??= self.LanguageModel.create({
    ...NANO_LANGS,
    initialPrompts: [{ role: "system", content: SYSTEM_PROMPT }],
    monitor: (m) => m.addEventListener("downloadprogress", (e) => onProgress?.(e.loaded)),
  });
  nanoBase.catch(() => (nanoBase = null));
  return nanoBase;
}

async function nanoChunk(base, context, lines) {
  const session = await base.clone();
  try {
    const prompt = [
      context.length ? "Earlier lines, for context only:\n" + context.join("\n") + "\n" : "",
      `Translate these ${lines.length} lines. Answer with a JSON array of exactly ${lines.length} strings, in order:`,
      ...lines.map((l, i) => `${i + 1}. ${l}`),
    ].join("\n");
    const raw = await session.prompt(prompt, {
      responseConstraint: { type: "array", items: { type: "string" }, minItems: lines.length, maxItems: lines.length },
    });
    const out = JSON.parse(raw);
    if (!Array.isArray(out) || out.length !== lines.length) throw new Error("Gemini Nano returned the wrong number of lines");
    return out.map((s) => String(s).trim());
  } finally {
    session.destroy();
  }
}

// On-device engines have no styles, but a Claude-less line still keys per style: it is retried
// with Claude when the style changes.
const keyPrefix = (lang, source) => source + ">" + lang + "/" + style + "\u0000";

// ---- Claude (via the background worker) ----

async function claudeSong(lines, lang, source, song, translationStyle) {
  const reply = await chrome.runtime.sendMessage({
    type: "claude-translate",
    lines,
    source,
    lang,
    style: translationStyle,
    title: song?.title,
    artist: song?.artist,
  });
  // No reply at all: the background worker is an older build without Claude (reload the extension).
  if (!reply?.translations) {
    const e = new Error(reply?.error ?? "Background worker didn't answer; reload the extension");
    e.declined = reply?.declined;
    throw e;
  }
  return reply;
}

// ---- public API ----

// Which on-device engine a language uses on this machine: "nano", "translator" or null.
export async function engineFor(lang, source = "ja") {
  if (source === "ja" && lang === "en" && (await nanoAvailability()) !== "unavailable") return "nano";
  return "Translator" in self ? "translator" : null;
}

// Call from a click handler the first time: creating either engine may download a model,
// which Chrome only allows after a user gesture. `onProgress` gets 0..1 while downloading.
export async function prepareEngine(lang, onProgress, source = "ja") {
  if (claudeOn) return "claude";
  const engine = await engineFor(lang, source);
  if (engine === "nano") return ensureNano(onProgress).then(() => engine);
  if (engine === "translator") return ensureTranslator(lang, onProgress, source).then(() => engine);
  throw new Error("No on-device translator in this Chrome (needs Chrome 138+)");
}

// How the latest translation of each song went, for the chip in the lyrics toolbar:
// { state: "working" | "ok" | "partial" | "failed" | "device", text, detail }.
const songStatus = new Map(); // prefix + lyrics -> status
const STYLE_NAME = { plain: "Normal", singable: "Translyrics", poetic: "Poetic" };

// Starts translating unique lines. Fills the cache that translateLine reads.
// `song` ({ title, artist }) is stored as local metadata only. `onStatus` is called
// with the song's status now (if known) and whenever it changes.
export function translateSong(lines, lang, source = "ja", song = null, onStatus = () => {}) {
  const translationStyle = style;
  const prefix = keyPrefix(lang, source);
  const lyrics = lines.filter((l) => l.trim()); // keep the original order; background deduplicates requests
  const statusKey = prefix + lyrics.join("\n");
  const report = (status) => (songStatus.set(statusKey, status), onStatus(status));
  const todo = [...new Set(lyrics)].filter((l) => !cache.has(prefix + l));
  if (!todo.length) {
    if (songStatus.has(statusKey)) onStatus(songStatus.get(statusKey));
    return;
  }

  const pending = new Map(todo.map((l) => [l, Promise.withResolvers()]));
  for (const [l, d] of pending) {
    d.promise.catch(() => { if (cache.get(prefix + l) === d.promise) cache.delete(prefix + l); });
    cache.set(prefix + l, d.promise);
  }

  const done = new Set();
  let fallbackWhy = ""; // why Claude didn't translate a line, added to the on-device lines' hover text
  const settle = (l, text, engine) => {
    sources.set(prefix + l, engine + fallbackWhy);
    pending.get(l).resolve(text);
    done.add(l);
  };
  (async () => {
    await claudeLoaded;
    if (claudeOn) {
      report({ state: "working", text: `Translating with Claude · ${STYLE_NAME[translationStyle]}…`, detail: "One request per unique line; repeated and saved lines are reused" });
      try {
        // Keep song storage stable; only individual lines are sent to the API.
        const { translations: out, cached, declinedLines, fallbackError } = await claudeSong(lyrics, lang, source, song, translationStyle);
        lyrics.forEach((l, j) => {
          if (!pending.has(l) || done.has(l) || out[j] == null) return; // repeats keep the first; skipped lines go on-device
          settle(l, out[j], `Translated by Claude Haiku 5.5${STYLE_LABEL[translationStyle] ?? ""}`);
        });
        fallbackWhy = fallbackError ? ` (Claude failed: ${fallbackError})` : " (Claude did not return a translation for this line)";
        const skipped = todo.filter((l) => !done.has(l)).length;
        const base = `Claude · ${STYLE_NAME[translationStyle]}${cached ? " · saved" : ""}`;
        report(
          skipped
            ? { state: "partial", text: `${base} · ${skipped} on-device`, detail: `${skipped} lines need the on-device translator.${declinedLines ? ` Claude declined ${declinedLines} unique lines.` : ""}${fallbackError ? ` ${fallbackError}` : ""}` }
            : {
                state: "ok",
                text: base,
                detail: cached ? "Loaded from this computer, no API call" : "Translated now and saved on this computer",
              }
        );
      } catch (e) {
        console.warn("[romaji-lyrics] Claude translation failed, using on-device:", e.message);
        fallbackWhy = ` (Claude failed: ${e.message})`;
        report(
          e.declined
            ? {
                state: "partial",
                text: "Claude declined · on-device",
                detail: "Claude did not return a translation; trying the on-device translator.",
              }
            : { state: "failed", text: "Claude failed · using on-device", detail: e.message }
        );
      }
    } else {
      report({ state: "device", text: "On-device translation", detail: "Add a Claude API key in the extension popup for better translations" });
    }
    const engine = todo.every((l) => done.has(l)) ? null : await engineFor(lang, source);
    if (engine === "nano") {
      const remaining = todo.filter((l) => !done.has(l));
      const base = await ensureNano().catch(() => null);
      for (let i = 0; base && i < remaining.length; i += CHUNK) {
        const chunk = remaining.slice(i, i + CHUNK);
        const context = remaining.slice(Math.max(0, i - CONTEXT), i);
        try {
          const out = await nanoChunk(base, context, chunk);
          chunk.forEach((l, j) => settle(l, out[j], "Translated on this device by Gemini Nano"));
        } catch {
          // fall through: these lines get the line-by-line translator below
        }
      }
    }
    // Line-by-line for Indonesian, and for anything Gemini Nano could not handle.
    for (const [l, d] of pending) {
      if (done.has(l)) continue;
      try {
        const t = await ensureTranslator(lang, undefined, source);
        const out = await t.translate(l);
        settle(l, lang === "id" ? normalizeIndonesian(out) : out, "Translated on this device by Chrome's translator");
      } catch (e) {
        d.reject(e);
      }
    }
    const failed = todo.filter((l) => !done.has(l)).length;
    if (failed) report({ state: "failed", text: `${failed} lines unavailable`, detail: "Claude and the on-device translator could not translate these lines. Other translations are kept." });
  })().catch((e) => {
    for (const [l, d] of pending) if (!done.has(l)) d.reject(e);
    report({ state: "failed", text: "Translation failed", detail: e.message });
  });
}

// Hover text for a translated line: which engine made it, and why Claude didn't when it fell back.
export const translationSource = (line, lang, source = "ja") => sources.get(keyPrefix(lang, source) + line) ?? "";

export function translateLine(line, lang, source = "ja") {
  const key = keyPrefix(lang, source) + line;
  if (!cache.has(key)) translateSong([line], lang, source);
  return cache.get(key);
}

// Language of a non-Japanese song, e.g. "en" or "ko", via Chrome's on-device LanguageDetector.
let detector = null;
export async function detectLanguage(text) {
  if (!("LanguageDetector" in self)) return "en";
  try {
    detector ??= self.LanguageDetector.create();
    const [top] = await (await detector).detect(text.slice(0, 2000));
    return top && top.confidence > 0.5 ? top.detectedLanguage.split("-")[0] : "en";
  } catch {
    detector = null;
    return "en";
  }
}
