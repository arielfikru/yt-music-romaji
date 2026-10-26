import { parseSongTitle } from "./claude.js";
import { pickByTitle, pickCandidate, searchQueries } from "./lrc.js";

const API = "https://lrclib.net/api/search?";
const cache = new Map(); // successful searches only; unavailable services are retried next time
const inflight = new Map();
export const clearLookupCache = () => cache.clear();
const normalize = (s) => s.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");

async function stage(parent, label, ms, next, work) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  parent.signal?.addEventListener("abort", cancel, { once: true });
  const startedAt = Date.now();
  const progress = { label, startedAt, deadline: startedAt + ms, next };
  parent.onProgress(progress);
  let timer;
  try {
    if (parent.signal?.aborted) return null;
    return await Promise.race([
      work({ signal: controller.signal, progress, onProgress: parent.onProgress }),
      new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(null); }, ms); }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    parent.signal?.removeEventListener("abort", cancel);
  }
}

async function search(params, task) {
  if (task.signal.aborted) return [];
  task.onProgress({ ...task.progress, detail: Object.values(params).filter(Boolean).join(" · ") });
  try {
    const response = await fetch(API + new URLSearchParams(params), {
      signal: AbortSignal.any([task.signal, AbortSignal.timeout(6000)]),
      headers: { "Lrclib-Client": "yt-music-romaji (personal Chrome extension)" },
    });
    return response.ok ? await response.json() : [];
  } catch { return []; }
}

function pooled(pool, rows) {
  for (const row of rows) pool.set(row.id ?? JSON.stringify([row.trackName, row.artistName, row.duration]), row);
  return [...pool.values()];
}

async function lookup(track, syncedOnly, options) {
  const { title, artist, duration, plain } = track;
  const direct = await stage(options, "Mencari di LRCLIB", 12_000, "Parsing Haiku", async (task) => {
    const pool = new Map();
    let best = null;
    for (const params of [...searchQueries(title, artist), { track_name: title }].slice(0, 7)) {
      if (task.signal.aborted) break;
      const rows = pooled(pool, await search(params, task));
      best = syncedOnly ? pickCandidate(rows, duration, plain) : pickByTitle(rows, track);
      if (syncedOnly && best) return { lrc: best.syncedLyrics };
      if (best?.lrc) return best;
    }
    return best;
  });
  if (direct) return direct;
  if (options.signal?.aborted) return {};
  const lookups = await stage(options, "Parsing judul & artis dengan Haiku", 20_000, "Pencarian artis asli", async (task) =>
    parseSongTitle({ title, artist }, { signal: task.signal }));
  if (!lookups?.length || options.signal?.aborted) return {};
  return await stage(options, "Mencari judul & artis asli di LRCLIB", 12_000, "Selesaikan pencarian", async (task) => {
    let best = null;
    for (const candidate of lookups) {
      if (task.signal.aborted) break;
      const pool = new Map();
      for (const params of [{ track_name: candidate.title, artist_name: candidate.artist }, { track_name: candidate.title }]) {
        if (task.signal.aborted) break;
        const rows = pooled(pool, await search(params, task));
        if (syncedOnly) {
          // On-page text and duration must match before timestamps are reused.
          const match = pickCandidate(rows, duration, plain);
          if (match) return { lrc: match.syncedLyrics };
        } else {
          // A different performer may have different timing even at the same duration.
          const allowSynced = normalize(title + " " + artist).includes(normalize(candidate.artist));
          const match = pickByTitle(rows, { ...candidate, duration, allowSynced });
          if (match?.lrc) return match;
          best ??= match;
        }
      }
      if (best) return best;
    }
    return best ?? {};
  }) ?? {};
}

export async function findLyrics(track, syncedOnly, { onProgress = () => {}, signal } = {}) {
  const key = JSON.stringify([syncedOnly, track.title, track.artist, Math.round(track.duration), track.plain ?? ""]);
  if (cache.has(key)) return cache.get(key);
  if (!inflight.has(key)) {
    const listeners = new Set();
    const job = { listeners, progress: null };
    const report = (progress) => { job.progress = progress; for (const listener of listeners) listener(progress); };
    // Defer until the first caller has subscribed below.
    job.promise = Promise.resolve().then(() => lookup(track, syncedOnly, { onProgress: report, signal })).then((result) => {
      if (result?.lrc || result?.plain) cache.set(key, result);
      return result ?? {};
    });
    inflight.set(key, job);
    job.promise.finally(() => inflight.delete(key)).catch(() => {});
  }
  const job = inflight.get(key);
  job.listeners.add(onProgress);
  if (job.progress) onProgress(job.progress);
  try { return await job.promise; }
  finally { job.listeners.delete(onProgress); }
}
