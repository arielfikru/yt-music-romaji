# YT Music Romaji Lyrics

Chrome extension (Manifest V3) that adds romaji, synced lyrics and translation to the lyrics on [YouTube Music](https://music.youtube.com).

## Features

- **Romaji** under every Japanese line (kuromoji + wanakana), with fixes for particles (は/へ/を), loanword katakana, bracketed sung readings like `運命(さだめ)`, iteration marks, and kanji missing from the dictionary.
- **Synced lyrics** from [LRCLIB](https://lrclib.net): the current line lights up and scrolls, click a line to jump, nudge timing ±0.5 s.
- **Lyrics for songs YouTube Music has none for**: the greyed-out Lyrics tab becomes clickable and shows lyrics found on LRCLIB.
- **Claude translation**: one target text line per request, with up to two lines before and after as context. Only the target is translated. All styles preserve meaning without adding imagery or expanding short phrases. Identical lines reuse the saved result for the same source language, target language and style, within and across songs; the first occurrence supplies context. Earlier prompt versions are retranslated once to replace over-expanded output. Up to three requests run at once; unavailable lines fall back to the on-device engines. Normal, Translyrics (singable adaptation), and Poetic styles are supported. Translyrics balances meaning, vocal phrasing, natural diction, rhythm and optional rhyme; it does not force casual slang or the shortest translation. It estimates fit from text and does not analyze audio/melody. Its earlier cached outputs are refreshed once; Normal and Poetic caches are retained.
- **Translation on your device**: English via Gemini Nano (whole-song context), Indonesian and other pairs via Chrome's Translator API. Non-Japanese songs are detected and translated too.
- **Haiku title and artist names** in the player bar, queue and lists (hover for the original). No local dictionary for names: without a key or if Haiku fails, the original stays visible. Requests batch up to 20 unique texts; permanent per-text caching and shared pending requests avoid repeating API calls, including across tabs. Export/import includes the name cache.
- **Hand corrections**: click *Edit* and type the romaji a song actually uses (e.g. 時間 sung as *toki*).
- **Live progress**: elapsed time, completed lines and the maximum wait before the next step. LRCLIB search → Haiku metadata parsing → original-artist search have 12/20/12 second limits. Claude translation has a 90 second limit, then unavailable lines use local engines. Completed lines appear immediately. Original-performer lyrics used for a cover remain unsynced when performer identity differs.
- Display modes (Both / Romaji / Original), font size, copy romaji.

## Install (unpacked)

```bash
npm install
npm run build
```

Then open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the `dist` folder.
After rebuilding, press ↻ on the extension card **and refresh the YouTube Music tab**.

## Development

- `npm test` — romaji regression cases (`dev/cases.mjs`), LRC parsing, LRCLIB matching, title case, pronoun normalisation, and mocked translation/cache regressions.
- `node test.mjs "<line>"` — print romaji for any line.
- `node dev/tokens.mjs "<text>"` — show kuromoji tokens.
- `dev/harness.html`, `dev/harness-notab.html` — fake YouTube Music pages for checking the UI (serve the repo root, e.g. `python3 -m http.server`).
- `node dev/build-kanji.mjs Unihan_Readings.txt` — regenerate `src/kanji-readings.js`.

| Path | What it does |
|---|---|
| `src/romaji.js` | Japanese line → romaji |
| `src/content.js` | Lyrics view, synced mode, Lyrics-tab panel, toolbar |
| `src/titles.js`, `src/name-client.js` | Haiku name display, batching and DOM restoration |
| `src/lookup.js`, `src/job-client.js` | Staged lookup, deadlines and live progress |
| `src/translate.js` | Claude orchestration / Gemini Nano / Translator API / language detection |
| `src/claude.js` | Per-line Claude requests, refusal handling and persistent cache |
| `src/lrc.js` | LRC parsing and picking the right LRCLIB entry |
| `src/background.js` | Service worker that queries LRCLIB |

## Credits

- [kuromoji.js](https://github.com/takuyaa/kuromoji.js) (Apache-2.0) and its IPADIC dictionary
- [WanaKana](https://github.com/WaniKani/WanaKana) (MIT)
- Kanji readings from the Unicode [Unihan database](https://www.unicode.org/charts/unihan.html) ([Unicode License](https://www.unicode.org/license.txt))
- Lyrics from [LRCLIB](https://lrclib.net)

## License

MIT, see [LICENSE](LICENSE). `src/kanji-readings.js` is derived from Unicode data under the Unicode License.

## Translyrics approach

The wording guidance follows the balance of singability, sense, naturalness, rhythm and rhyme described by [Peter Low](https://www.tandfonline.com/doi/abs/10.1080/0907676X.2003.9961466). [Johan Franzon](https://researchportal.helsinki.fi/en/publications/choices-in-song-translation-singability-in-print-subtitles-and-su/) distinguishes sung performance from subtitles. Here only text and neighboring lines are available, so the output still needs a listening/singing check against the melody.
