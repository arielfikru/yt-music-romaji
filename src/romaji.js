import { toHiragana, toKatakana, toRomaji } from "wanakana";
import KANJI_READINGS from "./kanji-readings.js";

const JP = /[぀-ヿ㐀-鿿豈-﫿ｦ-ﾟ]/;
const KANA_ONLY = /^[぀-ヺー-ヿ]+$/;
const KATAKANA_WORD = /^[\u30a1-\u30fa\u30fc]+$/;
const KANJI = /[㐀-鿿豈-﫿]/;
// Kana that wanakana should romanize; leaves out the middle dot ・ (U+30FB), which is punctuation.
const KANA_RUN = /[぀-ヺー-ヿ]+/g;

export function hasJapanese(text) {
  return JP.test(text);
}

// Brackets and Japanese punctuation that NFKC leaves alone.
const PUNCT = {
  "、": ",", "。": ".", "〜": "~",
  "「": "\"", "」": "\"", "『": "\"", "』": "\"", "【": "\"", "】": "\"",
  "《": "\"", "》": "\"", "〈": "\"", "〉": "\"", "“": "\"", "”": "\"",
};
const PUNCT_RE = new RegExp("[" + Object.keys(PUNCT).join("") + "]", "g");

// Loanword kana pairs wanakana splits (ティ -> "tei", ファ -> "fua").
const COMBOS = {
  ティ: "ti", ディ: "di", トゥ: "tu", ドゥ: "du", テュ: "tyu", デュ: "dyu",
  ファ: "fa", フィ: "fi", フェ: "fe", フォ: "fo", フュ: "fyu",
  ヴァ: "va", ヴィ: "vi", ヴェ: "ve", ヴォ: "vo", ヴュ: "vyu", ヴ: "vu",
  ウィ: "wi", ウェ: "we", ウォ: "wo", イェ: "ye",
  ツァ: "tsa", ツィ: "tsi", ツェ: "tse", ツォ: "tso",
  クァ: "kwa", クィ: "kwi", クェ: "kwe", クォ: "kwo", グァ: "gwa",
  スィ: "si", ズィ: "zi",
};
for (const k of Object.keys(COMBOS)) COMBOS[toHiragana(k)] = COMBOS[k];
const COMBO_RE = new RegExp(
  Object.keys(COMBOS).sort((a, b) => b.length - a.length).join("|"),
  "g"
);

// Set phrases whose は is pronounced わ even though the dictionary reads it ハ.
const FIXED = { こんにちは: "konnichiwa", こんばんは: "konbanwa" };

// Particles are read differently from how they are written.
const PARTICLE = { は: "wa", へ: "e", を: "o" };

// 等 after a pronoun or a word for people is the plural ら (僕等 = bokura), not トウ.
const PEOPLE = new Set(["子供", "子ども", "奴", "やつ", "友", "仲間", "女", "男", "人"]);
function isPluralRa(t, prev) {
  return t.surface_form === "等" && prev != null && (prev.pos_detail_1 === "代名詞" || PEOPLE.has(prev.surface_form));
}

// Okurigana tried, in order, to find a kun reading for a kanji the dictionary only knows inside a word.
const OKURIGANA = ["む", "る", "う", "く", "す", "つ", "ぶ", "ぐ", "ぬ", "い", "しい", "ろ", "やか", "らか"];
const kanjiReadings = new Map();

// On'yomi / kun'yomi from the Unihan table, as katakana.
function tableReading(kanji, preferOn) {
  const [on = "", kun = ""] = (KANJI_READINGS[kanji] ?? "").split("|");
  const pick = preferOn ? on || kun : kun || on;
  return pick ? toKatakana(pick) : null;
}

// Reading of one kanji on its own (e.g. 蔑 -> サゲス via 蔑む), or null if none is found.
// Inside a kanji compound (遮断桿) the on'yomi is the likely reading, so the table goes first there.
function kanjiReading(tokenizer, kanji, inCompound = false) {
  const cacheKey = kanji + (inCompound ? "|on" : "");
  if (kanjiReadings.has(cacheKey)) return kanjiReadings.get(cacheKey);
  if (inCompound && tableReading(kanji, true)) {
    kanjiReadings.set(cacheKey, tableReading(kanji, true));
    return kanjiReadings.get(cacheKey);
  }
  let found = null;
  for (const tail of [""].concat(OKURIGANA)) {
    const toks = tokenizer.tokenize(kanji + tail);
    const t = toks[0];
    const tailKana = toKatakana(tail);
    if (toks.length === 1 && t.word_type === "KNOWN" && t.reading && t.reading.endsWith(tailKana)) {
      found = t.reading.slice(0, t.reading.length - tailKana.length) || null;
      if (found) break;
    }
  }
  found ??= tableReading(kanji, true); // rare kanji on their own are mostly read by their on'yomi
  kanjiReadings.set(cacheKey, found);
  return found;
}

// Reading for a token the dictionary does not know, built kanji by kanji.
function unknownReading(tokenizer, t, next, prev) {
  const chars = [...t.surface_form];
  if (!chars.some((c) => KANJI.test(c))) return null;
  const compound = chars.length > 1 || afterKanjiNoun(prev);
  const readings = chars.map((c) => (KANJI.test(c) ? kanjiReading(tokenizer, c, compound) : toKatakana(c)));
  if (readings.some((r) => r == null)) return null;
  const reading = readings.join("");
  // Lyrics often write a kanji followed by its own reading (蔑さげすむ); skip the kanji then.
  const nextKana = next && kanaOf(next);
  if (nextKana && toKatakana(nextKana).startsWith(reading)) return "";
  return reading;
}

// 々 repeats the kanji before it. Kun'yomi repeats usually voice the first sound (星々 hoshiboshi,
// 花々 hanabana); on'yomi repeats don't (堂々 doudou). Common words are in the dictionary already.
function voiceFirst(kana) {
  const first = toKatakana(kana[0]);
  const v = (first + "\u3099").normalize("NFC");
  return (v.length === 1 ? v : first) + kana.slice(1);
}

function repeatReading(prev) {
  const surf = prev.surface_form;
  const last = surf.slice(-1);
  if (!KANJI.test(last)) return null;
  const base = [...surf].length === 1 ? kanaOf(prev) : tableReading(last, true);
  if (!base) return null;
  const on = (KANJI_READINGS[last] ?? "").split("|")[0];
  return toKatakana(base) === on ? base : voiceFirst(base);
}

// The previous token is a noun ending in kanji, so an unknown kanji right after it is part of the same word.
function afterKanjiNoun(prev) {
  return prev != null && prev.pos === "名詞" && KANJI.test(prev.surface_form.slice(-1));
}

// Glue a token onto the previous word ("tabe"+"masu", "futt"+"e") instead of starting a new one.
function isAttached(t, prev) {
  if (!prev) return false;
  const s = t.surface_form;
  if (t.pos === "助動詞") return /^(動詞|形容詞|助動詞)$/.test(prev.pos);
  if (t.pos_detail_1 === "接尾") return true;
  if (t.pos === "助詞" && t.pos_detail_1 === "接続助詞" && /^[てでば]$/.test(s)) return true;
  // 遮断 + 桿 (unknown) is one word: shadankan.
  if (t.word_type === "UNKNOWN" && KANJI.test(s[0]) && afterKanjiNoun(prev)) return true;
  // Katakana the dictionary does not know gets split into pieces (ミライ -> ミ + ライ); keep it one word.
  if (KATAKANA_WORD.test(s) && KATAKANA_WORD.test(prev.surface_form)) return true;
  // Contracted helpers: してる, 忘れちゃう, 読んどく.
  if (t.pos === "動詞" && t.pos_detail_1 === "非自立" && /^[てでちじとど]/.test(s)) return true;
  return false;
}

function kanaOf(t) {
  if (t.reading && t.reading !== "*") return t.reading;
  if (KANA_ONLY.test(t.surface_form)) return t.surface_form;
  return null;
}

// Each word is converted as a whole so a trailing っ doubles the next consonant ("フッ"+"テ" -> "futte").
function wordToRomaji(parts) {
  return parts
    .map((p) => (p.romaji != null ? p.romaji : p.kana != null ? p.kana : p.text))
    .join("")
    .replace(COMBO_RE, (k) => COMBOS[k])
    .replace(/[っッ]([bcdfghjkmpqrstvwxz])/g, "$1$1")
    .replace(KANA_RUN, (kana) => toRomaji(kana))
    .replace(/([aeiou])-/g, "$1$1");
}

// Words the dictionary reads with the wrong (counting) reading in song lyrics.
const WORD_FIXES = [
  [/一人/g, "ひとり"],
  [/二人/g, "ふたり"],
  [/\(笑\)/g, "(わらい)"],
];

// ゝ/ヽ repeat the previous kana, ゞ/ヾ repeat it voiced (いすゞ -> いすず).
function expandIteration(text) {
  return text.replace(/([\u3041-\u30fa])([ゝゞヽヾ]+)/g, (_, kana, marks) =>
    kana + [...marks].map((m) => (m === "ゞ" || m === "ヾ" ? (kana + "\u3099").normalize("NFC") : kana)).join("")
  );
}

const KANA_READING = "[\\p{Script=Hiragana}\\p{Script=Katakana}ー]+";
// 運命(さだめ) -> さだめ: the bracket holds the sung reading of the kanji.
const KANJI_WITH_READING = new RegExp("[\\p{Script=Han}々〆ヶ]+\\((" + KANA_READING + ")\\)", "gu");
// Love(ラブ) -> Love: the English word is what the reader wants to see.
const LATIN_WITH_READING = new RegExp("([A-Za-z][A-Za-z']*)\\(" + KANA_READING + "\\)", "gu");

// Normalise width (ｶﾅ, ＡＢＣ, １２３, …), then rewrite spellings the tokenizer misreads.
function prepare(line) {
  let s = line.normalize("NFKC");
  for (const [re, kana] of WORD_FIXES) s = s.replace(re, kana);
  return expandIteration(s)
    .replace(KANJI_WITH_READING, "$1")
    .replace(LATIN_WITH_READING, "$1")
    .replace(/・/g, " ・ ");
}

// Japanese runs (kana, kanji, Japanese punctuation); everything else is copied as is, so Latin text
// like "God's" or "[SUB]" is never split by the tokenizer, and brackets can't skew readings ("(神" -> シン).
const JP_SEGMENT = /([\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff66-\uff9f]+)/;
const needsSpace = (a, b) => /[\p{L}\p{N}\p{So}"!?.,)\]]$/u.test(a) && /^[\p{L}\p{N}"(\[]/u.test(b);

// `wordCase` restyles only the romaji we produce (titles use Title Case), never the copied text.
export function lineToRomaji(tokenizer, rawLine, wordCase = (s) => s) {
  if (!hasJapanese(rawLine)) return null;
  let out = "";
  prepare(rawLine)
    .split(JP_SEGMENT)
    .forEach((part, i) => {
      const piece = i % 2 ? wordCase(segmentToRomaji(tokenizer, part)) : part;
      if (!piece) return;
      if (out && needsSpace(out, piece)) out += " ";
      out += piece;
    });
  return out.replace(/\s+/g, " ").trim();
}

function segmentToRomaji(tokenizer, segment) {
  const words = []; // each word: array of parts, or a plain string for spacing/separators
  let prev = null;
  let glueNext = false;
  const tokens = tokenizer.tokenize(segment);
  tokens.forEach((t, i) => {
    const s = t.surface_form;
    if (/^\s+$/.test(s)) { words.push(" "); prev = null; glueNext = false; return; }
    if (s === "・") { words.push(" ", "·", " "); prev = null; glueNext = false; return; }

    const last = words[words.length - 1];
    if (/^々+$/.test(s) && prev && Array.isArray(last)) {
      const again = repeatReading(prev);
      if (again) {
        last.push({ kana: again.repeat(s.length) });
        return; // prev stays the kanji token, so 々 is part of its word
      }
    }

    const isLong = /^ー+$/.test(s); // すごーい: keep the stretched vowel inside the word
    const isOpen = /^[\p{Ps}\p{Pi}]+$/u.test(s);
    const isPunct = !isLong && (t.pos === "記号" || /^\p{P}+$/u.test(s));
    let part;
    if (FIXED[s]) part = { romaji: FIXED[s] };
    else if (t.pos === "助詞" && PARTICLE[s]) part = { romaji: PARTICLE[s] };
    else if (isLong) part = { kana: s };
    else if (isPunct) part = { text: s };
    else {
      const kana = isPluralRa(t, prev) ? "ラ" : kanaOf(t) ?? unknownReading(tokenizer, t, tokens[i + 1], prev);
      if (kana === "") return;
      part = { kana, text: s };
    }

    const glue = glueNext || isLong || (isPunct && !isOpen) || isAttached(t, prev);
    if (Array.isArray(last) && glue) {
      last.push(part);
    } else {
      if (Array.isArray(last)) words.push(" ");
      words.push([part]);
    }
    glueNext = isOpen || isLong;
    prev = t;
  });
  return words
    .map((w) => (typeof w === "string" ? w : wordToRomaji(w)))
    .join("")
    .replace(PUNCT_RE, (c) => PUNCT[c])
    .replace(/\s+/g, " ")
    .trim();
}
