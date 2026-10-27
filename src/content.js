import { hasJapanese, lineToRomaji } from "./romaji.js";
import { parseLrc } from "./lrc.js";
import { progressText, runWorkerTask } from "./job-client.js";
import { extensionAlive, getTokenizer, tokenizerReady } from "./tokenizer.js";
import { originalText, restoreTitles, romanizeTitles, romanizeTitle, resetNameCache } from "./titles.js";
import {
  detectLanguage,
  prepareEngine,
  resetTranslations,
  retryLine,
  setTranslationStyle,
  translateLine,
  translateSong,
  translationSource,
  translatorSupported,
  usingClaude,
} from "./translate.js";

// YT Music renders lyrics as one yt-formatted-string whose text has "\n" between lines.
const LYRICS_SELECTOR = "ytmusic-player-page ytmusic-description-shelf-renderer yt-formatted-string.description";

const MODES = [
  ["below", "Both"],
  ["romaji", "Romaji"],
  ["off", "Original"],
];
const TR_STYLES = [
  ["plain", "Normal", "Clear, casual translation of the meaning"],
  ["singable", "Translyrics", "Rhythmic translation with a similar syllable count per line"],
  ["poetic", "Poetic", "Elegant, concise wording that preserves the original meaning"],
];
const TR_LANGS = [
  ["id", "ID", "Translate into Indonesian"],
  ["en", "EN", "Translate into English"],
];
const FONT_MIN = 12;
const FONT_MAX = 32;
const FONT_STEP = 2;
const OFFSET_STEP = 0.5;
const USER_SCROLL_PAUSE_MS = 4000;

const DEFAULTS = { mode: "below", fontSize: 16, translate: false, lang: "id", style: "plain", titles: true, synced: true, about: false };
const MOOD_LABELS = {
  id: { sad: "Sedih", happy: "Ceria", romantic: "Romantis", longing: "Rindu", hopeful: "Penuh harapan", energetic: "Semangat",
    angry: "Marah", dark: "Kelam", calm: "Tenang", bittersweet: "Pahit-manis", playful: "Jenaka", absurd: "Absurd" },
  en: { sad: "Sad", happy: "Happy", romantic: "Romantic", longing: "Longing", hopeful: "Hopeful", energetic: "Energetic",
    angry: "Angry", dark: "Dark", calm: "Calm", bittersweet: "Bittersweet", playful: "Playful", absurd: "Absurd" },
};
const MEANING_LABELS = {
  id: { ambiguous: "Makna samar", nonsense: "Tanpa makna jelas" },
  en: { ambiguous: "Open to interpretation", nonsense: "Nonsense lyrics" },
};
const summaries = new Map(); // lang + lyrics -> Promise of the background reply
let settings = { ...DEFAULTS };

const romajiCache = new Map();
// Romaji the user typed for a Japanese line (songs that use special readings, e.g. 時間 sung as "toki").
let overrides = {};
let overridesVersion = 0;
const offsets = new Map(); // lyrics text -> seconds, kept for the session
const views = new WeakMap(); // lyrics element -> LyricsView

function autoRomaji(tk, line) {
  if (!romajiCache.has(line)) romajiCache.set(line, lineToRomaji(tk, line));
  return romajiCache.get(line);
}

function romajiFor(tk, line) {
  return overrides[line] ?? autoRomaji(tk, line);
}

async function saveOverride(line, romaji) {
  const { overrides: stored = {} } = await chrome.storage.local.get("overrides");
  if (romaji) stored[line] = romaji;
  else delete stored[line];
  await chrome.storage.local.set({ overrides: stored });
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function button(cls, label, onClick, attrs = {}) {
  const b = el("button", cls, label);
  b.type = "button";
  for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
  b.addEventListener("click", onClick);
  return b;
}

// Built with DOM calls: YT Music enforces Trusted Types, so innerHTML is blocked.
function icon(d) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}
const ICON_COPY = "M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z";
const ICON_EDIT = "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z";
const ICON_RETRY = "M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z";
const ICON_INFO = "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z";
const ICON_TRANSLATE = "m12.87 15.07-2.54-2.51.03-.03A17.52 17.52 0 0 0 14.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7 1.62-4.33L19.12 17h-3.24z";

function currentTrack(src = null) {
  const md = navigator.mediaSession?.metadata;
  const video = document.querySelector("video");
  const title = md?.title || originalText(document.querySelector("ytmusic-player-bar .title") ?? document.body).trim();
  const artist = md?.artist || "";
  const duration = video && Number.isFinite(video.duration) ? video.duration : 0;
  return title ? { title, artist, duration, plain: src?.textContent } : null;
}

// Renders lyrics into `block`. With `src` it replaces YT Music's own lyrics element; without it
// (standalone, for songs YT Music has no lyrics for) the lyrics come from LRCLIB alone.
class LyricsView {
  constructor(block, src = null, key = "") {
    this.src = src;
    this.block = block;
    this.standalone = !src;
    this.text = src ? src.textContent : key;
    this.lines = src ? this.text.split("\n").map((text) => ({ time: null, text })) : [];
    this.synced = false;
    this.syncStatus = this.standalone || settings.synced ? "searching" : "off";
    this.offset = offsets.get(this.text) ?? 0;
    this.alive = true;
    this.activeIdx = -1;
    this.pauseScrollUntil = 0;
    this.renderedKey = "";
    this.editing = false;
    this.lookupAbort = new AbortController();

    const pause = () => (this.pauseScrollUntil = Date.now() + USER_SCROLL_PAUSE_MS);
    this.onUserScroll = pause;
    block.addEventListener("wheel", pause, { passive: true });
    block.addEventListener("touchmove", pause, { passive: true });

    if (this.syncStatus === "searching") this.findSynced();
  }

  dispose() {
    this.alive = false;
    this.lookupAbort.abort();
    clearInterval(this.lookupTimer);
    cancelAnimationFrame(this.raf);
    this.block.removeEventListener("wheel", this.onUserScroll);
    this.block.removeEventListener("touchmove", this.onUserScroll);
  }

  async findSynced() {
    // Metadata can lag a moment behind the lyrics panel after a song change.
    await new Promise((r) => setTimeout(r, 600));
    const track = this.alive && currentTrack(this.src);
    if (!track) return this.setStatus("none");
    this.track = track;
    let reply;
    try {
      this.lookupTimer = setInterval(() => this.paintLookupStatus(), 1000);
      reply = await runWorkerTask(this.standalone ? "find-lyrics" : "find-synced-lyrics", track, (progress) => {
        this.lookupProgress = progress;
        this.paintLookupStatus();
      }, this.lookupAbort.signal);
      this.lookupError = reply?.error;
    } catch (e) {
      this.lookupError = e.message;
      reply = null;
    } finally { clearInterval(this.lookupTimer); }
    if (!this.alive) return;
    const timed = reply?.lrc ? parseLrc(reply.lrc) : [];
    if (timed.length && settings.synced) {
      this.lines = timed;
      this.synced = true;
      return this.setStatus("synced");
    }
    const plain = reply?.plain ?? (timed.length ? timed.map((l) => l.text).join("\n") : "");
    if (this.standalone && plain.trim()) {
      this.lines = plain.split("\n").map((text) => ({ time: null, text }));
      return this.setStatus("plain");
    }
    this.setStatus("none");
  }

  get japanese() {
    return this.lines.some((l) => hasJapanese(l.text));
  }

  // Lines worth translating: Japanese ones in a Japanese song, any line with words otherwise.
  needsTranslation(text) {
    return this.japanese ? hasJapanese(text) : /\p{L}/u.test(text);
  }

  async detectSource() {
    if (this.japanese) return "ja";
    this.detected ??= detectLanguage(this.lines.map((l) => l.text).join("\n"));
    return this.detected;
  }

  setStatus(status) {
    this.syncStatus = status;
    this.renderedKey = "";
    this.render();
  }

  // Re-renders only when something visible changed; cheap to call on every scan.
  async render() {
    const key = [settings.mode, settings.fontSize, settings.translate, settings.lang, settings.style, settings.about, this.syncStatus, this.offset, this.editing, overridesVersion].join("|");
    if (key === this.renderedKey) return;
    this.renderedKey = key;

    this.block.className =
      `rl-lyrics rl-mode-${settings.mode}` + (this.synced ? " rl-synced" : "") + (this.editing ? " rl-editing" : "");
    this.block.style.setProperty("--rl-jp", settings.fontSize + "px");
    this.src?.classList.add("rl-hidden");

    this.source = this.lines.length ? await this.detectSource() : "ja";
    if (!this.alive || key !== this.renderedKey) return;
    this.block.classList.toggle("rl-foreign", !this.japanese);
    const bar = this.toolbar();
    if (this.standalone && !this.lines.length) {
      const msg =
        this.syncStatus === "searching"
          ? skeleton()
          : el("div", "rl-status", this.lookupError || "No lyrics found for this song on LRCLIB. Covers and live versions are often missing.");
      // Nothing to act on yet, so the toolbar only shows while searching.
      this.block.replaceChildren(...(this.syncStatus === "searching" ? [bar] : []), msg);
      return;
    }
    if (!tokenizerReady() && settings.mode !== "off") this.block.replaceChildren(bar, skeleton());

    let tk;
    try {
      tk = await getTokenizer();
    } catch (e) {
      this.src?.classList.remove("rl-hidden");
      this.block.replaceChildren(bar, el("div", "rl-status", "Couldn't load the romaji dictionary: " + e.message));
      return;
    }
    if (!this.alive || key !== this.renderedKey) return;

    this.translating = settings.translate && this.source !== settings.lang;
    setTranslationStyle(settings.style);
    if (this.translating) this.startTranslation();
    this.rows = this.lines.map((line) => this.row(tk, line));
    const body = el("div", "rl-body");
    body.append(...this.rows);
    const about = this.aboutCard();
    this.block.replaceChildren(bar, ...(about ? [about] : []), body);
    this.activeIdx = -1;
    if (this.synced) this.startSync();
  }

  row(tk, line) {
    const text = line.text;
    if (!text.trim()) {
      if (!this.synced) return el("div", "rl-gap");
      const r = el("div", "rl-line rl-instrumental", "♪");
      this.makeSeekable(r, line);
      return r;
    }
    const r = el("div", "rl-line");
    const romaji = hasJapanese(text) ? romajiFor(tk, text) : null;
    if (settings.mode !== "romaji" || !romaji) r.append(el("div", "rl-jp", text));
    if (romaji && (settings.mode !== "off" || this.editing)) {
      const ro = el("div", "rl-romaji" + (text in overrides ? " rl-edited" : ""), romaji);
      if (this.editing) this.makeEditable(ro, text, tk);
      r.append(ro);
    }
    if (this.translating && this.needsTranslation(text)) {
      const tr = el("div", "rl-tr");
      this.fillTranslation(tr, text, translateLine(text, settings.lang, this.source));
      r.append(tr);
    }
    if (this.synced) this.makeSeekable(r, line);
    return r;
  }

  // What the song is about: mood, how much sense it makes, and a short summary. Waits for the
  // synced-lyrics search so one song isn't summarized twice (YT Music's text, then LRCLIB's).
  aboutCard() {
    if (!settings.about || !usingClaude() || !this.lines.length) return null;
    const lang = settings.lang;
    const card = el("div", "rl-about");
    card.setAttribute("role", "region");
    card.setAttribute("aria-label", "About this song");
    if (this.syncStatus === "searching") {
      card.append(el("div", "rl-about-text rl-about-muted", "Menunggu lirik lengkap…"));
      return card;
    }
    const lines = this.lines.map((l) => l.text);
    const key = lang + "\u0000" + lines.join("\n");
    const load = (again = false) => {
      if (again) summaries.delete(key);
      if (!summaries.has(key)) {
        const track = this.track ?? currentTrack(this.src);
        const job = runWorkerTask("claude-summary", { lines, source: this.source, lang, title: track?.title ?? "", artist: track?.artist ?? "" });
        summaries.set(key, job);
        job.then((r) => r?.error && summaries.delete(key), () => summaries.delete(key));
      }
      card.replaceChildren(el("div", "rl-about-text rl-about-muted", lang === "id" ? "Membaca isi lagu…" : "Reading the song…"));
      summaries.get(key).then((r) => {
        if (!r || r.error) {
          const retry = button("rl-btn", null, () => load(true));
          retry.append(icon(ICON_RETRY), el("span", null, "Coba lagi"));
          card.replaceChildren(el("div", "rl-about-text rl-about-error", r?.error ?? "Ringkasan gagal"), retry);
          return;
        }
        const tags = el("div", "rl-about-tags");
        tags.append(el("span", `rl-mood rl-mood-${r.mood}`, MOOD_LABELS[lang]?.[r.mood] ?? r.mood));
        const meaning = MEANING_LABELS[lang]?.[r.meaning];
        if (meaning) tags.append(el("span", "rl-mood rl-mood-meaning", meaning));
        for (const t of r.themes ?? []) tags.append(el("span", "rl-theme", t));
        card.replaceChildren(tags, el("div", "rl-about-text", r.summary));
        card.title = r.cached ? "Tersimpan di komputer ini, tanpa panggilan API" : "Dibuat Claude Haiku 5.5 dan disimpan";
      }, (e) => card.replaceChildren(el("div", "rl-about-text rl-about-error", e.message)));
    };
    load();
    return card;
  }

  // The lines sent for translation, in order; also the context for a single-line retry.
  get trLines() {
    return this.lines.map((l) => l.text).filter((t) => this.needsTranslation(t));
  }

  startTranslation(force = false) {
    translateSong(this.trLines, settings.lang, this.source, this.track ?? currentTrack(this.src),
      (status) => this.paintTrStatus(status), force);
  }

  // Shows a line's translation once `job` settles, with a ↻ to ask for another version.
  // A failed line stays visible with its reason instead of silently disappearing.
  fillTranslation(tr, text, job) {
    const lang = settings.lang;
    const token = (tr.rlJob = {}); // a newer retry wins over a slower earlier answer
    tr.className = "rl-tr rl-tr-loading";
    tr.replaceChildren(el("span", "rl-tr-text", "…"));
    tr.title = "";
    const retry = (failed) => {
      const b = button("rl-tr-retry" + (failed ? " rl-tr-retry-shown" : ""), null, (e) => {
        e.stopPropagation(); // don't seek the song
        const avoid = failed ? "" : tr.querySelector(".rl-tr-text")?.textContent ?? "";
        const again = retryLine(text, lang, this.source, { lines: this.trLines, avoid });
        // Repeats of this line (a chorus) show the new version too.
        this.rows.forEach((row, i) => {
          const other = this.lines[i].text === text && row.querySelector(".rl-tr");
          if (other) this.fillTranslation(other, text, again);
        });
      }, {
        title: failed ? "Coba terjemahkan lagi" : "Terjemahan lain untuk baris ini",
        "aria-label": failed ? "Retry translation" : "Retranslate this line",
      });
      b.append(icon(ICON_RETRY));
      if (failed) b.append(el("span", null, "Coba lagi"));
      return b;
    };
    job.then(
      (t) => {
        if (tr.rlJob !== token) return;
        tr.className = "rl-tr";
        tr.replaceChildren(el("span", "rl-tr-text", t), retry(false));
        tr.title = translationSource(text, lang, this.source);
      },
      (e) => {
        if (tr.rlJob !== token) return;
        tr.className = "rl-tr rl-tr-failed";
        tr.replaceChildren(el("span", "rl-tr-text", "Belum diterjemahkan"), retry(true));
        tr.title = e?.message ?? "";
      }
    );
  }

  makeSeekable(r, line) {
    r.tabIndex = 0;
    r.setAttribute("role", "button");
    const seek = () => {
      if (this.editing) return;
      const video = document.querySelector("video");
      if (!video) return;
      video.currentTime = Math.max(0, line.time - this.offset + 0.01);
      this.pauseScrollUntil = 0;
    };
    r.addEventListener("click", seek);
    r.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), seek()));
  }

  makeEditable(ro, line, tk) {
    ro.contentEditable = "plaintext-only";
    ro.spellcheck = false;
    ro.title = "Type the romaji you hear. Enter saves, Esc cancels, empty resets.";
    const before = ro.textContent;
    ro.addEventListener("click", (e) => e.stopPropagation());
    ro.addEventListener("keydown", (e) => {
      e.stopPropagation(); // keep YT Music shortcuts (space, j, k...) out of the editor
      if (e.key === "Enter") (e.preventDefault(), ro.blur());
      if (e.key === "Escape") (ro.textContent = before), ro.blur();
    });
    ro.addEventListener("blur", () => {
      const typed = ro.textContent.replace(/\s+/g, " ").trim();
      if (typed === before) return;
      saveOverride(line, typed && typed !== autoRomaji(tk, line) ? typed : null);
    });
  }

  toggleEditing() {
    this.editing = !this.editing;
    this.pauseScrollUntil = this.editing ? Infinity : 0;
    this.renderedKey = "";
    this.render();
  }

  startSync() {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (!this.alive || !this.block.isConnected) return;
      const video = document.querySelector("video");
      if (video) this.highlight(video.currentTime + this.offset);
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  highlight(t) {
    let idx = -1;
    for (let lo = 0, hi = this.lines.length - 1; lo <= hi; ) {
      const mid = (lo + hi) >> 1;
      if (this.lines[mid].time <= t) (idx = mid), (lo = mid + 1);
      else hi = mid - 1;
    }
    if (idx === this.activeIdx) return;
    this.rows.forEach((r, i) => {
      r.classList.toggle("rl-active", i === idx);
      r.classList.toggle("rl-past", i < idx);
    });
    this.activeIdx = idx;
    if (idx >= 0 && Date.now() > this.pauseScrollUntil) {
      this.rows[idx].scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  setOffset(next) {
    this.offset = Math.round(next * 10) / 10;
    offsets.set(this.text, this.offset);
    this.renderedKey = "";
    this.render();
  }

  // A row of radio buttons bound to one setting, e.g. the display mode or the translation style.
  segmented(key, options, ariaLabel) {
    const seg = el("div", "rl-seg");
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", ariaLabel);
    for (const [value, label, title] of options) {
      seg.append(
        button("rl-seg-btn", label, () => chrome.storage.sync.set({ [key]: value }), {
          role: "radio",
          "aria-checked": String(settings[key] === value),
          ...(title ? { title } : {}),
        })
      );
    }
    return seg;
  }

  toolbar() {
    const bar = el("div", "rl-toolbar");
    const seg = this.segmented("mode", MODES, "Lyrics display");

    const tr = button("rl-btn rl-tr-btn", null, () => this.toggleTranslate(tr), {
      "aria-pressed": String(settings.translate),
      title: usingClaude()
        ? "Translate with Claude (one request per unique line; saved lines are reused)"
        : translatorSupported()
        ? "Translate on this device (English uses Gemini Nano when available)"
        : "Needs Chrome 138+ (built-in translator)",
    });
    tr.append(icon(ICON_TRANSLATE), el("span", null, "Translate"));
    tr.disabled = !translatorSupported() || this.source === settings.lang;
    if (this.source === settings.lang) tr.title = "These lyrics are already in your translation language";

    const edit = button("rl-btn", null, () => this.toggleEditing(), {
      "aria-pressed": String(this.editing),
      title: "Fix romaji by hand for this song's special readings",
    });
    edit.append(icon(ICON_EDIT), el("span", null, this.editing ? "Done" : "Edit"));

    const main = el("div", "rl-row");
    if (this.japanese) main.append(seg, tr, edit);
    else main.append(tr);
    if (usingClaude()) {
      const about = button("rl-btn", null, () => chrome.storage.sync.set({ about: !settings.about }), {
        "aria-pressed": String(settings.about),
        title: "Ringkasan isi lagu, mood dan tema (Claude, sekali per lagu, disimpan)",
      });
      about.append(icon(ICON_INFO), el("span", null, "Tentang"));
      main.append(about);
    }

    const actions = el("div", "rl-row");
    for (const [label, delta, name] of [["A−", -FONT_STEP, "Smaller text"], ["A+", FONT_STEP, "Larger text"]]) {
      const next = settings.fontSize + delta;
      const b = button("rl-btn rl-size-btn", label, () => chrome.storage.sync.set({ fontSize: next }), {
        title: name,
        "aria-label": name,
      });
      b.disabled = next < FONT_MIN || next > FONT_MAX;
      actions.append(b);
    }
    const copy = button("rl-btn", null, () => this.copyRomaji(copyLabel));
    const copyLabel = el("span", null, "Copy romaji");
    copy.append(icon(ICON_COPY), copyLabel);
    if (this.japanese) actions.append(copy);

    bar.append(main, actions);
    // Translation settings sit next to the lyrics they change, only while translating.
    if (settings.translate && !tr.disabled) {
      const trRow = el("div", "rl-row rl-tr-row");
      if (usingClaude()) trRow.append(this.segmented("style", TR_STYLES, "Translation style"));
      trRow.append(this.segmented("lang", TR_LANGS, "Translate into"));
      const again = button("rl-btn", null, () => this.retryAll(), {
        title: usingClaude()
          ? "Terjemahkan ulang semua baris dengan Claude (memanggil API lagi untuk setiap baris unik)"
          : "Terjemahkan ulang semua baris",
      });
      again.append(icon(ICON_RETRY), el("span", null, "Ulang semua"));
      trRow.append(again);
      this.trChip = el("span", "rl-chip rl-tr-status");
      this.trChip.setAttribute("role", "status");
      trRow.append(this.trChip);
      this.paintTrStatus(this.trStatus);
      bar.append(trRow);
    }
    const sync = this.syncBar();
    return sync ? [bar, sync].reduce((frag, n) => (frag.append(n), frag), document.createDocumentFragment()) : bar;
  }

  // Updates the translation chip in place, so a status change doesn't re-render the lyrics.
  paintTrStatus(status) {
    this.trStatus = status;
    if (!this.trChip) return;
    this.trChip.hidden = !status;
    if (!status) return;
    this.trChip.className = `rl-chip rl-tr-status rl-tr-${status.state}`;
    this.trChip.textContent = status.text;
    this.trChip.title = status.detail ?? "";
  }

  paintLookupStatus() {
    if (!this.alive || this.syncStatus !== "searching" || !this.lookupChip || !this.lookupProgress) return;
    this.lookupChip.textContent = progressText(this.lookupProgress);
    this.lookupChip.title = this.lookupProgress.detail || "Batas waktu tahap, bukan perkiraan waktu selesai";
  }

  syncBar() {
    if (this.syncStatus === "off") return null;
    const row = el("div", "rl-syncbar");
    if (this.syncStatus === "searching") {
      this.lookupChip = el("span", "rl-chip rl-progress", "Menyiapkan pencarian…");
      this.paintLookupStatus();
      row.append(this.lookupChip);
    } else if (this.syncStatus === "none") {
      if (this.standalone) return null; // the body already says nothing was found
      row.append(el("span", "rl-chip rl-chip-muted", this.lookupError || "No synced version found"));
    } else if (this.syncStatus === "plain") {
      row.append(el("span", "rl-chip rl-chip-muted", "Lyrics from LRCLIB · timing doesn't match this version"));
    } else {
      row.append(el("span", "rl-chip rl-chip-live", "Synced · LRCLIB"));
      const off = el("div", "rl-row rl-offset");
      const label = (this.offset > 0 ? "+" : "") + this.offset.toFixed(1) + "s";
      off.append(
        button("rl-btn rl-size-btn", "−", () => this.setOffset(this.offset - OFFSET_STEP), {
          title: "Lyrics later",
          "aria-label": "Show lyrics later",
        }),
        el("span", "rl-offset-value", label),
        button("rl-btn rl-size-btn", "+", () => this.setOffset(this.offset + OFFSET_STEP), {
          title: "Lyrics earlier",
          "aria-label": "Show lyrics earlier",
        })
      );
      row.append(off);
    }
    return row;
  }

  retryAll() {
    this.startTranslation(true);
    for (const [i, line] of this.lines.entries()) {
      const tr = this.rows?.[i]?.querySelector(".rl-tr");
      if (tr) this.fillTranslation(tr, line.text, translateLine(line.text, settings.lang, this.source));
    }
  }

  async toggleTranslate(btn) {
    const on = !settings.translate;
    if (on) {
      // Create the engine inside the click so Chrome allows a model download.
      const label = btn.querySelector("span");
      label.textContent = "Preparing…";
      try {
        await prepareEngine(
          settings.lang,
          (p) => (label.textContent = `Downloading ${Math.round(p * 100)}%`),
          this.source
        );
      } catch (e) {
        btn.querySelector("span").textContent = "Unavailable";
        btn.title = e.message;
        return;
      }
    }
    chrome.storage.sync.set({ translate: on });
  }

  async copyRomaji(label) {
    try {
      const tk = await getTokenizer();
      const text = this.lines
        .map((l) => (l.text.trim() ? (hasJapanese(l.text) ? romajiFor(tk, l.text) : l.text) : ""))
        .join("\n");
      await navigator.clipboard.writeText(text);
      label.textContent = "Copied";
    } catch {
      label.textContent = "Copy failed";
    }
    setTimeout(() => (label.textContent = "Copy romaji"), 1600);
  }
}

function skeleton() {
  const wrap = el("div", "rl-skeleton");
  wrap.setAttribute("aria-label", "Loading romaji");
  for (const w of [72, 58, 80, 46, 66, 52]) {
    const bar = el("div", "rl-skel-line");
    bar.style.width = w + "%";
    wrap.append(bar);
  }
  return wrap;
}

function blockFor(src) {
  let block = src.previousElementSibling;
  if (!block?.classList.contains("rl-lyrics")) {
    block = el("div", "rl-lyrics");
    src.before(block);
  }
  return block;
}

function restore(src) {
  views.get(src)?.dispose();
  views.delete(src);
  src.classList.remove("rl-hidden");
  const prev = src.previousElementSibling;
  if (prev?.classList.contains("rl-lyrics")) prev.remove();
}

function renderLyrics(src) {
  const text = src.textContent;
  if (!text.trim()) return restore(src);
  let view = views.get(src);
  if (!view || view.text !== text) {
    view?.dispose(); // song changed
    view = new LyricsView(blockFor(src), src);
    views.set(src, view);
  }
  view.render();
}

// ---- Songs YT Music has no lyrics for: its Lyrics tab is disabled ----
// We make that tab clickable again and open our own panel over the tab content, fed by LRCLIB.

const TAB_SELECTOR = "ytmusic-player-page tp-yt-paper-tab";
const panel = { open: false, viaTab: false, root: null, block: null, title: null, view: null, key: "" };
let pill = null;

// Tabs are Up next, Lyrics, then Comments/Related.
function lyricsTab() {
  const tabs = document.querySelectorAll(TAB_SELECTOR);
  return tabs.length >= 3 ? tabs[1] : null;
}
const isDisabled = (tab) => tab.hasAttribute("disabled") || tab.getAttribute("aria-disabled") === "true";
const isVisible = (n) => n.getBoundingClientRect().width > 0;

function trackKey() {
  const md = navigator.mediaSession?.metadata;
  return md?.title ? md.title + "\u0000" + (md.artist || "") : "";
}

// Covers the tab content area (below the tab strip, above the player bar), or the right side as a fallback.
function panelRect() {
  const bar = document.querySelector("ytmusic-player-bar");
  const bottom = bar && isVisible(bar) ? bar.getBoundingClientRect().top : innerHeight - 72;
  const tab = lyricsTab();
  const strip = tab?.closest("tp-yt-paper-tabs") ?? tab?.parentElement;
  if (panel.viaTab && strip && isVisible(strip)) {
    const r = strip.getBoundingClientRect();
    return { left: r.left, top: r.bottom, width: r.width, height: bottom - r.bottom };
  }
  const width = Math.min(560, innerWidth * 0.42);
  return { left: innerWidth - width - 16, top: 72, width, height: bottom - 72 };
}

function closePanel() {
  panel.open = false;
  panel.viaTab = false;
  panel.view?.dispose();
  panel.view = null;
  panel.key = "";
  panel.root?.remove();
  panel.root = null;
  lyricsTab()?.classList.remove("rl-tab-active");
}

function openPanel(viaTab) {
  panel.open = true;
  panel.viaTab = viaTab;
  if (viaTab) lyricsTab()?.classList.add("rl-tab-active");
  updatePanel();
}

async function updatePanel() {
  if (!panel.open) return;
  if (!panel.root?.isConnected) {
    panel.root = el("div", "rl-panel");
    panel.root.setAttribute("role", "region");
    panel.root.setAttribute("aria-label", "Lyrics");
    const head = el("div", "rl-panel-head");
    panel.title = el("div", "rl-panel-title");
    head.append(
      panel.title,
      button("rl-btn rl-size-btn", "✕", closePanel, { "aria-label": "Close lyrics", title: "Close lyrics" })
    );
    panel.block = el("div", "rl-lyrics");
    panel.root.append(head, panel.block);
    document.body.append(panel.root);
    panel.key = "";
  }
  const r = panelRect();
  Object.assign(panel.root.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });

  const key = trackKey();
  if (key) paintPanelTitle(key);
  if (!key || key === panel.key) return panel.view?.render();
  panel.key = key;
  panel.view?.dispose();
  const block = el("div", "rl-lyrics"); // fresh element so the old view's listeners go with it
  panel.block.replaceWith(block);
  panel.block = block;
  panel.root.scrollTop = 0;
  panel.view = new LyricsView(block, null, "track:" + key);
  panel.view.render();

}

async function paintPanelTitle(key) {
  const title = navigator.mediaSession?.metadata?.title || "";
  const displayKey = JSON.stringify([key, title, settings.titles, usingClaude()]);
  if (panel.displayKey === displayKey && panel.title.textContent) return;
  panel.displayKey = displayKey;
  panel.title.textContent = title;
  panel.title.title = title;
  if (settings.titles && usingClaude() && hasJapanese(title)) {
    const display = await romanizeTitle(title);
    if (panel.displayKey === displayKey && panel.title.isConnected) panel.title.textContent = display;
  }
}

// Keeps the disabled Lyrics tab clickable while the current song has no YT Music lyrics.
function syncLyricsTab() {
  const tab = lyricsTab();
  if (!tab) return false;
  const forced = isDisabled(tab);
  tab.classList.toggle("rl-tab-forced", forced);
  if (!forced && panel.viaTab) closePanel(); // new song has real lyrics; YT Music's own tab takes over
  if (panel.viaTab && !isVisible(tab)) closePanel(); // player page was minimised
  return true;
}

function forcedTabFrom(target) {
  const tab = target instanceof Element ? target.closest(TAB_SELECTOR) : null;
  return tab?.classList.contains("rl-tab-forced") ? tab : null;
}

// Capture at the document so YT Music's own tab handlers never see clicks on the disabled tab.
for (const type of ["pointerdown", "mousedown", "touchstart", "pointerup", "mouseup", "click"]) {
  document.addEventListener(
    type,
    (e) => {
      const forced = forcedTabFrom(e.target);
      if (forced) {
        e.stopImmediatePropagation();
        if (type === "click") {
          e.preventDefault();
          panel.open && panel.viaTab ? closePanel() : openPanel(true);
        }
        return;
      }
      // Any other player tab closes our panel, like switching tabs normally would.
      if (type === "click" && panel.viaTab && e.target instanceof Element && e.target.closest(TAB_SELECTOR)) closePanel();
    },
    true
  );
}

// Fallback when the tab strip can't be found (YT Music changed its markup): a small floating button.
function syncPill(tabFound) {
  const show = !tabFound && Boolean(trackKey());
  if (show && !pill) {
    pill = button("rl-pill", "あ Lyrics", () => (panel.open ? closePanel() : openPanel(false)), {
      "aria-label": "Show lyrics",
    });
    document.body.append(pill);
  } else if (!show && pill) {
    pill.remove();
    pill = null;
  }
}

addEventListener("resize", () => updatePanel());

async function scan() {
  document.querySelectorAll(LYRICS_SELECTOR).forEach(renderLyrics);
  syncPill(syncLyricsTab());
  updatePanel();
  if (settings.titles && usingClaude()) {
    try {
      await romanizeTitles();
    } catch {
      // Keep original names when Haiku is unavailable
    }
  }
}

// A newer copy of this script takes over after the extension reloads (once the tab is refreshed);
// this one removes everything it added and stops, instead of erroring on every page change.
function teardown() {
  observer.disconnect();
  clearTimeout(timer);
  closePanel();
  syncPill(true);
  document.querySelectorAll(".rl-lyrics").forEach((n) => n.remove());
  document.querySelectorAll(".rl-hidden").forEach((n) => n.classList.remove("rl-hidden"));
  document.querySelectorAll(".rl-tab-forced").forEach((n) => n.classList.remove("rl-tab-forced", "rl-tab-active"));
  restoreTitles();
}

let timer = 0;
const observer = new MutationObserver((records) => {
  if (!extensionAlive()) return teardown();
  const ours = (r) => (r.target.nodeType === 1 ? r.target : r.target.parentElement)?.closest(".rl-lyrics, .rl-panel, .rl-pill");
  if (records.every(ours)) return;
  clearTimeout(timer);
  timer = setTimeout(scan, 200);
});
observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

chrome.storage.local.get("overrides", ({ overrides: stored }) => {
  overrides = stored ?? {};
  overridesVersion++;
  chrome.storage.sync.get(DEFAULTS, (s) => {
    settings = s;
    scan();
  });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    if (changes.overrides) {
      overrides = changes.overrides.newValue ?? {};
      overridesVersion++;
      scan();
    }
    if (changes.claudeKey) {
      restoreTitles();
      resetNameCache();
      // Re-translate open lyrics with (or without) Claude right away, no reload needed.
      resetTranslations();
      overridesVersion++;
      scan();
    }
    return;
  }
  for (const k of Object.keys(DEFAULTS)) if (changes[k]) settings[k] = changes[k].newValue;
  if (changes.titles && !settings.titles) restoreTitles();
  if (changes.synced) {
    // Rebuild views so they start or stop looking for synced lyrics.
    document.querySelectorAll(LYRICS_SELECTOR).forEach((src) => {
      views.get(src)?.dispose();
      views.delete(src);
    });
  }
  scan();
});
