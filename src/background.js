import { cacheEntries, checkKey, clearCache, importCache, parseSongTitle, translateWithClaude } from "./claude.js";
import { pickByTitle, pickCandidate, searchQueries } from "./lrc.js";

const API = "https://lrclib.net/api/search?";
const cache = new Map(); // "title\0artist\0duration" -> syncedLyrics | null

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// LRCLIB search results. LRCLIB is often briefly overloaded (503), so a failed search is retried once;
// if it still fails it counts as no results, and `lookup.failed` keeps the empty answer out of the cache.
async function search(params, lookup = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(API + new URLSearchParams(params), {
        headers: { "Lrclib-Client": "yt-music-romaji (personal Chrome extension)" },
      });
      if (res.ok) return await res.json();
      if (res.status !== 503 && res.status !== 429) return [];
    } catch {
      // network error: retry below
    }
    if (attempt === 0) await sleep(1500);
  }
  lookup.failed = true;
  return [];
}

async function findSynced({ title, artist, duration, plain }) {
  const key = [title, artist, Math.round(duration)].join("\u0000");
  if (cache.has(key)) return cache.get(key);
  const lookup = {};
  const attempts = [{ track_name: title, artist_name: artist }, { q: `${title} ${artist}` }, { track_name: title }];
  let found = null;
  for (const params of attempts) {
    const pick = pickCandidate(await search(params, lookup), duration, plain);
    if (pick) {
      found = pick.syncedLyrics;
      break;
    }
  }
  // YT Music often shows a romanized title ("Tokusou Sentai Dekarenjaa") where LRCLIB has the Japanese one.
  // The lyrics on the page still decide the match, so a wrong guess can't pick another song.
  for (const l of found ? [] : await parseSongTitle({ title, artist })) {
    const pick =
      pickCandidate(await search({ track_name: l.title, artist_name: l.artist }, lookup), duration, plain) ??
      pickCandidate(await search({ track_name: l.title }, lookup), duration, plain);
    if (pick) {
      found = pick.syncedLyrics;
      break;
    }
  }
  if (found || !lookup.failed) cache.set(key, found);
  return found;
}

// For songs YT Music has no lyrics for: search by (often messy) video title, match by name.
const byTitleCache = new Map();
async function findByTitle({ title, artist, duration }) {
  const key = [title, artist, Math.round(duration)].join("\u0000");
  if (byTitleCache.has(key)) return byTitleCache.get(key);
  const lookup = {};
  const pool = new Map();
  let best = null;
  for (const params of searchQueries(title, artist).slice(0, 6)) {
    for (const r of await search(params, lookup)) pool.set(r.id, r);
    best = pickByTitle([...pool.values()], { title, artist, duration });
    if (best?.lrc) break; // timing matches; no need to keep searching
  }
  if (!best) best = await findByParsedTitle({ title, artist, duration }, lookup);
  if (best || !lookup.failed) byTitleCache.set(key, best ?? {});
  return best ?? {};
}

// Fallback when the video title is too messy for searchQueries: Claude names the real song
// (original title, original artist, cover artist), and those names count as matches too.
async function findByParsedTitle({ title, artist, duration }, lookup) {
  const lookups = await parseSongTitle({ title, artist });
  if (!lookups.length) return null;
  const known = { title: [title, ...lookups.map((l) => l.title)].join(" "), artist: [artist, ...lookups.map((l) => l.artist)].join(" "), duration };
  const pool = new Map();
  let best = null;
  for (const l of lookups) {
    for (const params of [{ track_name: l.title, artist_name: l.artist }, { q: `${l.title} ${l.artist}` }]) {
      for (const r of await search(params, lookup)) pool.set(r.id, r);
      best = pickByTitle([...pool.values()], known);
      if (best?.lrc) return best;
    }
  }
  return best;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    "find-synced-lyrics": () => findSynced(msg).then((lrc) => ({ lrc })),
    "find-lyrics": () => findByTitle(msg),
    "claude-translate": () => translateWithClaude(msg),
    "claude-check-key": () => checkKey(msg.key),
    "claude-cache-export": () => cacheEntries().then((entries) => ({ entries })),
    "claude-cache-import": () => importCache(msg.entries).then((count) => ({ count })),
    "claude-cache-clear": () => clearCache().then(() => ({})),
  };
  const job = handlers[msg?.type]?.();
  if (!job) return;
  job.then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true; // keeps the channel open for the async reply
});
