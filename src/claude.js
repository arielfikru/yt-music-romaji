// Song translation with Claude, run from the background worker (content scripts can't reach the API).
// Each song is sent whole in one request, so lines that continue a sentence translate as one thought.
// Results are kept in chrome.storage.local, so a song only costs an API call the first time.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-5-5";
const PREFIX = "tr:"; // storage keys: "tr:" + lang + ":" + sha256 of the song
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
    "Keep pronouns and tone the same through the whole song.",
    STYLE[lang] ?? "Write casually, not formally.",
    "Keep it poetic and simple. Leave English words, names and sounds like 'la la' as they are.",
    "Return exactly one translation per numbered line, in order. Repeated lines get the same translation.",
  ].join(" ");
}

const SCHEMA = {
  type: "object",
  properties: { translations: { type: "array", items: { type: "string" } } },
  required: ["translations"],
  additionalProperties: false,
};

async function songKey(lines, source, lang) {
  const bytes = new TextEncoder().encode(source + "\n" + lines.join("\n"));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return PREFIX + lang + ":" + hex;
}

function explain(e) {
  if (e instanceof Anthropic.AuthenticationError) return "Claude API key is invalid";
  if (e instanceof Anthropic.PermissionDeniedError) return "This API key can't use " + MODEL;
  if (e instanceof Anthropic.RateLimitError) return "Claude rate limit hit, try again in a moment";
  if (e instanceof Anthropic.APIError) return `Claude API error ${e.status ?? ""}: ${e.message}`.trim();
  return String(e?.message ?? e);
}

async function callClaude(lines, source, lang) {
  const { claudeKey } = await chrome.storage.local.get("claudeKey");
  if (!claudeKey) throw new Error("No Claude API key set");
  const client = new Anthropic({ apiKey: claudeKey, dangerouslyAllowBrowser: true });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: systemPrompt(source, lang),
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: lines.map((l, i) => `${i + 1}. ${l}`).join("\n") }],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined to translate this song");
  if (response.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off");
  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  const out = JSON.parse(text).translations;
  if (!Array.isArray(out) || out.length !== lines.length) {
    throw new Error(`Claude returned ${out?.length ?? 0} lines for ${lines.length}`);
  }
  return out.map((s) => String(s).trim());
}

// Translations for `lines` (unique, non-empty, in song order), from storage or one Claude call.
export async function translateWithClaude({ lines, source, lang }) {
  const key = await songKey(lines, source, lang);
  if (!inflight.has(key)) {
    const job = (async () => {
      const { [key]: stored } = await chrome.storage.local.get(key);
      if (stored?.t?.length === lines.length) return stored.t;
      const t = await callClaude(lines, source, lang);
      await chrome.storage.local.set({ [key]: { t, lines, source, lang, model: MODEL, at: Date.now() } });
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

// ---- cache management for the popup ----

export async function cacheEntries() {
  const all = await chrome.storage.local.get(null);
  return Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith(PREFIX)));
}

export async function importCache(entries) {
  const valid = Object.entries(entries ?? {}).filter(([k, v]) => k.startsWith(PREFIX) && Array.isArray(v?.t));
  await chrome.storage.local.set(Object.fromEntries(valid));
  return valid.length;
}

export async function clearCache() {
  await chrome.storage.local.remove(Object.keys(await cacheEntries()));
}
