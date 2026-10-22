import { pickByTitle, pickCandidate, searchQueries } from "./lrc.js";

const API = "https://lrclib.net/api/search?";
const cache = new Map(); // "title\0artist\0duration" -> syncedLyrics | null

async function search(params) {
  const res = await fetch(API + new URLSearchParams(params), {
    headers: { "Lrclib-Client": "yt-music-romaji (personal Chrome extension)" },
  });
  if (!res.ok) return [];
  return res.json();
}

async function findSynced({ title, artist, duration, plain }) {
  const key = [title, artist, Math.round(duration)].join("\u0000");
  if (cache.has(key)) return cache.get(key);
  const attempts = [{ track_name: title, artist_name: artist }, { q: `${title} ${artist}` }, { track_name: title }];
  let found = null;
  for (const params of attempts) {
    const pick = pickCandidate(await search(params), duration, plain);
    if (pick) {
      found = pick.syncedLyrics;
      break;
    }
  }
  cache.set(key, found);
  return found;
}

// For songs YT Music has no lyrics for: search by (often messy) video title, match by name.
const byTitleCache = new Map();
async function findByTitle({ title, artist, duration }) {
  const key = [title, artist, Math.round(duration)].join("\u0000");
  if (byTitleCache.has(key)) return byTitleCache.get(key);
  const pool = new Map();
  let best = null;
  for (const params of searchQueries(title, artist).slice(0, 6)) {
    for (const r of await search(params)) pool.set(r.id, r);
    best = pickByTitle([...pool.values()], { title, artist, duration });
    if (best?.lrc) break; // timing matches; no need to keep searching
  }
  byTitleCache.set(key, best ?? {});
  return best ?? {};
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const job =
    msg?.type === "find-synced-lyrics"
      ? findSynced(msg).then((lrc) => ({ lrc }))
      : msg?.type === "find-lyrics"
        ? findByTitle(msg)
        : null;
  if (!job) return;
  job.then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true; // keeps the channel open for the async reply
});
