import assert from "node:assert/strict";
import { parseLrc, lyricsOverlap, pickCandidate } from "../src/lrc.js";
import { titleCase } from "../src/titles.js";

// Own sample text, not song lyrics.
const lrc = "[ar:Someone]\n[00:01.50]朝が来た\n[00:05.00][01:05.00]空は青い\n[00:09.2]<00:09.20>風<00:09.80>が吹く\n[00:12.00]";
const lines = parseLrc(lrc);
assert.deepEqual(lines.map((l) => l.time), [1.5, 5, 9.2, 12, 65]);
assert.equal(lines[2].text, "風が吹く");
assert.equal(lines[3].text, "");

const plain = "朝が来た\n空は青い！\n\n風が吹く";
assert.equal(lyricsOverlap(lines, plain), 1);
assert.equal(lyricsOverlap(lines, "全然違う歌\n別の行"), 0);

const results = [
  { syncedLyrics: lrc, duration: 250 }, // another version
  { syncedLyrics: null, duration: 200 }, // no timestamps
  { syncedLyrics: lrc, duration: 203, id: "good" },
  { syncedLyrics: "[00:01.00]全然違う歌", duration: 200 }, // another song, same length
];
assert.equal(pickCandidate(results, 200, plain).id, "good");
assert.equal(pickCandidate(results, 120, plain), null);

assert.equal(titleCase("sore o bokura wa kamisama to yobu"), "Sore o Bokura wa Kamisama to Yobu");
assert.equal(titleCase("HoneyWorks \"toukyou samaa\""), "HoneyWorks \"Toukyou Samaa\"");
assert.equal(titleCase("ClariS ALIVE music video"), "ClariS ALIVE Music Video");
assert.equal(titleCase("kuyamu to kaite mirai"), "Kuyamu to Kaite Mirai");
console.log("lrc + title tests passed");

// ---- title-based lookup ----
import { searchQueries, pickByTitle } from "../src/lrc.js";
const messy = "【女性が歌う】フィクション/sumika『ヲタクに恋は難しい』主題歌(Full Covered by コバソロ & 相沢)";
const qs = searchQueries(messy, "kobasolo");
assert.deepEqual(qs[1], { track_name: "フィクション", artist_name: "sumika" });
assert.ok(qs.some((q) => q.track_name === "ヲタクに恋は難しい"));
const official = searchQueries("アイドル", "YOASOBI");
assert.deepEqual(official, [{ track_name: "アイドル", artist_name: "YOASOBI" }]);
const mv = searchQueries("YOASOBI「アイドル」Official Music Video", "Ayase / YOASOBI");
assert.ok(mv.some((q) => q.track_name === "アイドル"));

const pool = [
  { trackName: "フィクション", artistName: "other band", syncedLyrics: lrc, duration: 248 }, // wrong artist
  { trackName: "フィクション", artistName: "sumika", syncedLyrics: lrc, plainLyrics: "朝が来た", duration: 230 },
];
assert.deepEqual(pickByTitle(pool, { title: messy, artist: "kobasolo", duration: 248 }), { plain: "朝が来た" });
assert.deepEqual(pickByTitle(pool, { title: messy, artist: "kobasolo", duration: 231 }), { lrc });
assert.equal(pickByTitle(pool, { title: "全然違う曲", artist: "誰か", duration: 230 }), null);
console.log("title lookup tests passed");

// ---- Indonesian pronoun normalisation ----
import { normalizeIndonesian } from "../src/translate.js";
assert.equal(normalizeIndonesian("Saya ingin bertemu Anda"), "Aku ingin bertemu kamu");
assert.equal(normalizeIndonesian("Bahkan saya tahu. Anda juga"), "Bahkan aku tahu. Kamu juga");
assert.equal(normalizeIndonesian("rumah Anda, \"saya pulang\""), "rumah kamu, \"Aku pulang\"");
assert.equal(normalizeIndonesian("SAYA DI SINI"), "AKU DI SINI");
assert.equal(normalizeIndonesian("Pasaya tidak berubah"), "Pasaya tidak berubah"); // whole words only
console.log("pronoun tests passed");
