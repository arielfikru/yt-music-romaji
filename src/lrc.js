// LRC parsing and picking the right LRCLIB entry for the song that is playing.

const LINE_TS = /^\s*\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/;
const WORD_TS = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;

// "[01:02.50][02:10.00] text" -> [{ time: 62.5, text }, { time: 130, text }], sorted by time.
export function parseLrc(lrc) {
  const out = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const times = [];
    let rest = raw;
    let m;
    while ((m = LINE_TS.exec(rest))) {
      times.push(Number(m[1]) * 60 + Number(m[2].replace(":", ".")));
      rest = rest.slice(m[0].length);
    }
    if (!times.length) continue; // metadata tags like [ar:...] or plain text
    const text = rest.replace(WORD_TS, "").trim();
    for (const time of times) out.push({ time, text });
  }
  return out.sort((a, b) => a.time - b.time);
}

const norm = (s) => s.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");

// Share of the LRC's distinct lines that also appear in the lyrics YouTube Music shows.
export function lyricsOverlap(lrcLines, plainText) {
  const plain = new Set(plainText.split("\n").map(norm).filter(Boolean));
  const lrc = [...new Set(lrcLines.map((l) => norm(l.text)).filter(Boolean))];
  if (!lrc.length || !plain.size) return 0;
  return lrc.filter((l) => plain.has(l)).length / lrc.length;
}

const MAX_DURATION_DIFF = 8; // seconds; further off is usually another version (live, TV size)
const MIN_OVERLAP = 0.25;

// Best LRCLIB search result for this song, or null. `plainText` guards against picking another song.
export function pickCandidate(results, duration, plainText) {
  const scored = [];
  for (const r of results) {
    if (!r.syncedLyrics || r.instrumental) continue;
    const diff = duration ? Math.abs((r.duration || 0) - duration) : 0;
    if (diff > MAX_DURATION_DIFF) continue;
    const lines = parseLrc(r.syncedLyrics);
    if (plainText && lyricsOverlap(lines, plainText) < MIN_OVERLAP) continue;
    scored.push({ r, diff });
  }
  scored.sort((a, b) => a.diff - b.diff);
  return scored[0]?.r ?? null;
}

// ---- Lookup when YouTube Music has no lyrics (uploads, covers, MVs) ----

const QUOTED = /[「『"“]([^」』"”]+)[」』"”]/g;
const GROUPS = /【[^】]*】|\[[^\]]*\]|\([^)]*\)/g;
const NOISE = /full\s*ver(sion)?|covered by.*|cover(ed)?|歌ってみた|弾いてみた|official\s*(music\s*)?video|music\s*video|\bmv\b|\bpv\b|lyrics?|主題歌|挿入歌|tv\s*size|op\b|ed\b/gi;

// LRCLIB search parameter sets to try, most specific first.
export function searchQueries(title, artist) {
  const t = title.normalize("NFKC");
  const quoted = [...t.matchAll(QUOTED)].map((m) => m[1].trim());
  const base = t.replace(GROUPS, " ").replace(QUOTED, " ").replace(NOISE, " ").replace(/\s+/g, " ").trim();
  const parts = base.split(/\s*(?:\/|\||｜|\s-\s|\s–\s|\s—\s)\s*/).filter((p) => p.length > 0);

  const out = [{ track_name: title, artist_name: artist }];
  if (parts.length >= 2) {
    out.push({ track_name: parts[0], artist_name: parts[1] }, { track_name: parts[1], artist_name: parts[0] });
  }
  for (const q of quoted) out.push({ track_name: q });
  if (base && base !== title) out.push({ q: base });
  const seen = new Set();
  return out.filter((p) => {
    const k = JSON.stringify(p);
    return !seen.has(k) && seen.add(k);
  });
}

// Pick by name when there is no on-page lyrics text to compare with. Both the track and the artist
// must appear in the video title/artist, so a same-named song by someone else is never chosen.
// Returns { lrc } when the timing fits this recording, else { plain } (a cover is usually longer or shorter).
export function pickByTitle(results, { title, artist, duration }) {
  const hay = norm(title + " " + artist);
  let best = null;
  for (const r of results) {
    if (r.instrumental) continue;
    const tn = norm(r.trackName || "");
    const an = norm(r.artistName || "");
    if (tn.length < 2 || !hay.includes(tn) || !an || !hay.includes(an)) continue;
    const timed = Boolean(r.syncedLyrics) && duration > 0 && Math.abs((r.duration || 0) - duration) <= 3;
    const plain = r.plainLyrics || (r.syncedLyrics ? parseLrc(r.syncedLyrics).map((l) => l.text).join("\n") : "");
    if (!timed && !plain) continue;
    const score = (timed ? 1000 : 0) + tn.length + an.length;
    if (!best || score > best.score) best = { score, lrc: timed ? r.syncedLyrics : null, plain };
  }
  return best && (best.lrc ? { lrc: best.lrc } : { plain: best.plain });
}
