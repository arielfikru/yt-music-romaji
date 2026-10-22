import { hasJapanese, lineToRomaji } from "./romaji.js";

// Song titles, artists and albums across YT Music: player bar, queue, lists, shelves, page headers.
const TITLE_SELECTORS = [
  "ytmusic-player-bar .title",
  "ytmusic-player-bar .byline",
  "ytmusic-player-queue-item .song-title",
  "ytmusic-player-queue-item .byline",
  "ytmusic-responsive-list-item-renderer .title",
  "ytmusic-responsive-list-item-renderer .secondary-flex-columns",
  "ytmusic-two-row-item-renderer .title",
  "ytmusic-two-row-item-renderer .subtitle",
  "ytmusic-responsive-header-renderer .title",
  "ytmusic-responsive-header-renderer .strapline-text",
  "ytmusic-immersive-header-renderer .title",
  "ytmusic-detail-header-renderer .title",
  "ytmusic-card-shelf-renderer .title",
  "ytmusic-card-shelf-renderer .subtitle",
].join(",");

// Words kept lowercase inside a title-cased romaji title.
const SMALL = new Set(["wa", "o", "no", "ni", "to", "ga", "de", "e", "mo", "ka", "ya", "yo", "ne", "na", "he", "by", "feat", "ft"]);

// Only all-lowercase words are romaji we generated; Latin already in the title (HoneyWorks, ClariS) stays as is.
export function titleCase(s) {
  return s
    .split(" ")
    .map((w, i) => {
      const m = /^(\W*)([a-z][a-z']*)(\W*)$/.exec(w);
      if (!m || (i > 0 && SMALL.has(m[2]))) return w;
      return m[1] + m[2][0].toUpperCase() + m[2].slice(1) + m[3];
    })
    .join(" ");
}

export function titleRomaji(tk, text) {
  const [, lead, body, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const romaji = lineToRomaji(tk, body, titleCase);
  return romaji ? lead + romaji + trail : null;
}

const swapped = new WeakMap(); // text node -> { original, romaji }
const touched = new Set(); // text nodes we rewrote, so they can be restored

// Original (Japanese) text of an element whose text nodes we may have rewritten.
export function originalText(el) {
  let out = "";
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const s = swapped.get(n);
    out += s && n.nodeValue === s.romaji ? s.original : n.nodeValue;
  }
  return out;
}

export function romanizeTitles(tk) {
  for (const el of document.querySelectorAll(TITLE_SELECTORS)) {
    let changed = false;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const prev = swapped.get(n);
      if (prev && n.nodeValue === prev.romaji) continue;
      const original = n.nodeValue;
      if (!hasJapanese(original)) continue;
      const romaji = titleRomaji(tk, original);
      if (!romaji || romaji === original) continue;
      swapped.set(n, { original, romaji });
      touched.add(n);
      n.nodeValue = romaji;
      changed = true;
    }
    if (changed) el.title = originalText(el); // hover shows the Japanese
  }
  if (touched.size > 2000) for (const n of touched) if (!n.isConnected) touched.delete(n);
}

export function restoreTitles() {
  for (const n of touched) {
    const s = swapped.get(n);
    if (s && n.nodeValue === s.romaji) n.nodeValue = s.original;
    n.parentElement?.closest(TITLE_SELECTORS)?.removeAttribute("title");
  }
  touched.clear();
}
