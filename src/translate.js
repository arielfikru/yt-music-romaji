// On-device translation, nothing leaves the machine.
// - English: Gemini Nano (Prompt API) translates the song in chunks with surrounding lines as context.
// - Indonesian, or when Gemini Nano is unavailable: Chrome's Translator API, line by line.

const translators = new Map(); // target language -> Promise<Translator>
const cache = new Map(); // lang + line -> Promise<string>

export const translatorSupported = () => "Translator" in self || "LanguageModel" in self;

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

// ---- public API ----

// Which engine a language uses on this machine: "nano", "translator" or null.
export async function engineFor(lang, source = "ja") {
  if (source === "ja" && lang === "en" && (await nanoAvailability()) !== "unavailable") return "nano";
  return "Translator" in self ? "translator" : null;
}

// Call from a click handler the first time: creating either engine may download a model,
// which Chrome only allows after a user gesture. `onProgress` gets 0..1 while downloading.
export async function prepareEngine(lang, onProgress, source = "ja") {
  const engine = await engineFor(lang, source);
  if (engine === "nano") return ensureNano(onProgress).then(() => engine);
  if (engine === "translator") return ensureTranslator(lang, onProgress, source).then(() => engine);
  throw new Error("No on-device translator in this Chrome (needs Chrome 138+)");
}

// Starts translating a whole song so lines share context. Fills the cache that translateLine reads.
export function translateSong(lines, lang, source = "ja") {
  const prefix = source + ">" + lang + "\u0000";
  const todo = [...new Set(lines.filter((l) => l.trim()))].filter((l) => !cache.has(prefix + l));
  if (!todo.length) return;

  const pending = new Map(todo.map((l) => [l, Promise.withResolvers()]));
  for (const [l, d] of pending) {
    d.promise.catch(() => cache.delete(prefix + l));
    cache.set(prefix + l, d.promise);
  }

  const done = new Set();
  (async () => {
    const engine = await engineFor(lang, source);
    if (engine === "nano") {
      const base = await ensureNano().catch(() => null);
      for (let i = 0; base && i < todo.length; i += CHUNK) {
        const chunk = todo.slice(i, i + CHUNK);
        const context = todo.slice(Math.max(0, i - CONTEXT), i);
        try {
          const out = await nanoChunk(base, context, chunk);
          chunk.forEach((l, j) => (pending.get(l).resolve(out[j]), done.add(l)));
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
        d.resolve(lang === "id" ? normalizeIndonesian(out) : out);
      } catch (e) {
        d.reject(e);
      }
    }
  })();
}

export function translateLine(line, lang, source = "ja") {
  const key = source + ">" + lang + "\u0000" + line;
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
