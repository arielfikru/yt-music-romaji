// Claude calls, run from the background worker (content scripts can't reach the API):
// - song translation: each song is sent whole in one request, so lines that continue a sentence
//   translate as one thought;
// - reading the real song title and artist out of a messy video title, for the LRCLIB search.
// Results are kept in chrome.storage.local, so each song only costs an API call the first time.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-5-5";
// Bump when the translation prompt changes: saved songs from an older prompt are translated again once.
const PROMPT_VERSION = 2;
const PREFIX = "tr:"; // storage keys: "tr:" + lang + ":" + sha256 of the song
const PARSE_PREFIX = "parse:"; // "parse:" + sha256 of video title + artist
const LANGS = { id: "Indonesian", en: "English", ja: "Japanese", ko: "Korean", zh: "Chinese", es: "Spanish", fr: "French" };
const STYLE = {
  id: "Write casual, everyday Indonesian the way people talk and sing: aku/kamu (never saya/anda), words like gak, udah, aja, banget where they fit. Never stiff or formal.",
  en: "Write casual, natural spoken English. Never stiff or formal.",
};

const inflight = new Map(); // storage key -> Promise<string[]>

const langName = (code) => LANGS[code] ?? code;

function systemPrompt(source, lang) {
  return [
    `You translate ${langName(source)} song lyrics into ${langName(lang)}.`,
    "You get the whole song as numbered lines. Read all of it first: work out who is singing to whom, what omitted subjects refer to, and where a sentence runs over several lines.",
    "Translate the song as one piece, not line by line. When a sentence spans lines, phrase it so it reads naturally across them, and split it back over the same lines.",
    "Translate what each line means, not word for word. Japanese lyrics are dense and poetic: noun lists, wordplay, slang, religious or archaic terms.",
    "Render them as something an Indonesian listener would understand and could sing along to, keeping the image and the feeling; use the song's title and artist, if you know the song, to get its meaning right.",
    "Never leave Japanese characters in a translation, and never transliterate a word instead of translating it (only names stay as they are).",
    "Keep pronouns and tone the same through the whole song.",
    STYLE[lang] ?? "Write casually, not formally.",
    "Keep it poetic and simple. Leave English words, names and sounds like 'la la' as they are.",
    "Return one entry per numbered line, with its number, covering every line. Repeated lines get the same translation.",
  ].join(" ");
}

const SCHEMA = {
  type: "object",
  properties: {
    translations: {
      type: "array",
      items: {
        type: "object",
        properties: { n: { type: "integer" }, text: { type: "string" } },
        required: ["n", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["translations"],
  additionalProperties: false,
};

async function sha256(text) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const songKey = async (lines, source, lang) => PREFIX + lang + ":" + (await sha256(source + "\n" + lines.join("\n")));

function explain(e) {
  if (e instanceof Anthropic.AuthenticationError) return "Invalid API key";
  if (e instanceof Anthropic.PermissionDeniedError) return "This key can't use Claude Haiku 5.5";
  if (e instanceof Anthropic.NotFoundError) return "Claude Haiku 5.5 isn't available for this key";
  if (e instanceof Anthropic.RateLimitError) return "Rate limited, try again in a moment";
  if (e instanceof Anthropic.APIConnectionError) return "Can't reach Anthropic (offline?)";
  // The API's own message, e.g. "Your credit balance is too low…", rather than the raw JSON.
  if (e instanceof Anthropic.APIError) return e.error?.error?.message ?? `API error ${e.status ?? ""}`.trim();
  return String(e?.message ?? e);
}

// What the popup shows next to the key: set by the key check and by every real API call.
const setStatus = (ok, message) => chrome.storage.local.set({ claudeStatus: { ok, message, at: Date.now() } });

// A tiny real request (a fraction of a cent), so it also catches an empty credit balance.
export async function checkKey(apiKey) {
  try {
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 0, timeout: 20_000 });
    await client.messages.create({
      model: MODEL,
      max_tokens: 16,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "Reply with OK." }],
    });
    await setStatus(true, "Key works");
    return { ok: true };
  } catch (e) {
    await setStatus(false, explain(e));
    return { ok: false, error: explain(e) };
  }
}

async function client() {
  const { claudeKey } = await chrome.storage.local.get("claudeKey");
  if (!claudeKey) throw new Error("No Claude API key set");
  return new Anthropic({ apiKey: claudeKey, dangerouslyAllowBrowser: true });
}

// The JSON answer of a structured-output request, after checking it finished normally.
function jsonAnswer(response) {
  if (response.stop_reason === "refusal") throw new Error("Claude declined this request");
  if (response.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off");
  return JSON.parse(response.content.find((b) => b.type === "text")?.text ?? "");
}

// Runs a Claude request, keeping the popup's status in step with how it went.
async function tracked(request, done = "Working") {
  try {
    const out = await request();
    await setStatus(true, typeof done === "function" ? done(out) : done);
    return out;
  } catch (e) {
    await setStatus(false, explain(e));
    throw e;
  }
}

const songHeader = (song) =>
  song?.title ? `Song: ${song.title}${song.artist ? " — " + song.artist : ""}\n\n` : "";

async function callClaude(lines, source, lang, song) {
  const response = await (await client()).messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: systemPrompt(source, lang),
    output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: songHeader(song) + lines.map((l, i) => `${i + 1}. ${l}`).join("\n") }],
  });
  // Matched by number, so a skipped or merged line costs only that line (it falls back to on-device).
  const t = lines.map(() => null);
  for (const { n, text } of jsonAnswer(response).translations ?? []) {
    if (n >= 1 && n <= lines.length && String(text).trim()) t[n - 1] = String(text).trim();
  }
  const missing = t.filter((x) => x === null).length;
  if (missing > lines.length / 2) throw new Error(`Claude translated only ${lines.length - missing} of ${lines.length} lines`);
  return t;
}

// Translations for `lines` (unique, non-empty, in song order), from storage or one Claude call.
export async function translateWithClaude({ lines, source, lang, title, artist }) {
  const key = await songKey(lines, source, lang);
  if (!inflight.has(key)) {
    const job = (async () => {
      const { [key]: stored } = await chrome.storage.local.get(key);
      if (stored?.t?.length === lines.length && stored.v === PROMPT_VERSION) return stored.t;
      const t = await tracked(
        () => callClaude(lines, source, lang, { title, artist }),
        (t) => `Translated a song (${t.filter(Boolean).length} lines)`
      );
      await chrome.storage.local.set({ [key]: { t, lines, source, lang, title, artist, v: PROMPT_VERSION, model: MODEL, at: Date.now() } });
      return t;
    })();
    inflight.set(key, job);
    job.finally(() => inflight.delete(key)).catch(() => {}); // the caller below reports the error
  }
  try {
    return { translations: await inflight.get(key) };
  } catch (e) {
    return { error: explain(e) };
  }
}

// ---- song title parsing ----

const PARSE_SYSTEM = [
  "You identify songs from YouTube video titles, for a search on the LRCLIB lyrics database.",
  "Uploads are often covers, game versions (Project Sekai, etc.), fan uploads or MVs, with extra words like FULL VER, Reloaded, cover, 歌ってみた, MV.",
  "Return up to 4 lookups, most likely first. Each is the song's title and an artist LRCLIB would list it under.",
  "Include the title in its original script (e.g. Japanese) and, if different, its common romanized or English title;",
  "include the original artist (for Vocaloid songs, the producer, e.g. DECO*27) and the performing artist or unit if it's a cover.",
  "Never invent a song. If the video is not a song, return an empty list.",
].join(" ");

const PARSE_SCHEMA = {
  type: "object",
  properties: {
    lookups: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, artist: { type: "string" } },
        required: ["title", "artist"],
        additionalProperties: false,
      },
    },
  },
  required: ["lookups"],
  additionalProperties: false,
};

// [{ title, artist }] guesses for an upload's real song, from storage or one Claude call. [] without a key.
export async function parseSongTitle({ title, artist }) {
  const { claudeKey } = await chrome.storage.local.get("claudeKey");
  if (!claudeKey || !title) return [];
  const key = PARSE_PREFIX + (await sha256(title + "\u0000" + artist));
  if (!inflight.has(key)) {
    const job = (async () => {
      const { [key]: stored } = await chrome.storage.local.get(key);
      if (Array.isArray(stored?.lookups)) return stored.lookups;
      const response = await tracked(
        async () =>
        (await client()).messages.create({
          model: MODEL,
          max_tokens: 4000,
          system: PARSE_SYSTEM,
          output_config: { effort: "low", format: { type: "json_schema", schema: PARSE_SCHEMA } },
          messages: [{ role: "user", content: `Video title: ${title}\nChannel / artist: ${artist || "(unknown)"}` }],
        }),
        "Looked up the song name"
      );
      const lookups = (jsonAnswer(response).lookups ?? [])
        .map((l) => ({ title: String(l.title).trim(), artist: String(l.artist).trim() }))
        .filter((l) => l.title)
        .slice(0, 4);
      await chrome.storage.local.set({ [key]: { lookups, title, artist, model: MODEL, at: Date.now() } });
      return lookups;
    })();
    inflight.set(key, job);
    job.finally(() => inflight.delete(key)).catch(() => {});
  }
  try {
    return await inflight.get(key);
  } catch (e) {
    console.warn("[romaji-lyrics] Claude couldn't read the song title:", explain(e));
    return [];
  }
}

// ---- cache management for the popup ----

// Everything Claude produced: translations and parsed titles. The popup counts only translations.
export async function cacheEntries() {
  const all = await chrome.storage.local.get(null);
  return Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith(PREFIX) || k.startsWith(PARSE_PREFIX)));
}

export async function importCache(entries) {
  const valid = Object.entries(entries ?? {}).filter(
    ([k, v]) => (k.startsWith(PREFIX) && Array.isArray(v?.t)) || (k.startsWith(PARSE_PREFIX) && Array.isArray(v?.lookups))
  );
  await chrome.storage.local.set(Object.fromEntries(valid));
  return valid.length;
}

export async function clearCache() {
  await chrome.storage.local.remove(Object.keys(await cacheEntries()));
}
