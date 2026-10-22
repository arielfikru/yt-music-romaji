# YT Music Romaji Lyrics

Chrome extension (Manifest V3) that adds romaji, synced lyrics and translation to the lyrics on [YouTube Music](https://music.youtube.com).

## Features

- **Romaji** under every Japanese line (kuromoji + wanakana), with fixes for particles (は/へ/を), loanword katakana, bracketed sung readings like `運命(さだめ)`, iteration marks, and kanji missing from the dictionary.
- **Synced lyrics** from [LRCLIB](https://lrclib.net): the current line lights up and scrolls, click a line to jump, nudge timing ±0.5 s.
- **Lyrics for songs YouTube Music has none for**: the greyed-out Lyrics tab becomes clickable and shows lyrics found on LRCLIB.
- **Translation on your device**: English via Gemini Nano (whole-song context), Indonesian and other pairs via Chrome's Translator API. Non-Japanese songs are detected and translated too.
- **Romaji song titles** in the player bar, queue and lists (hover for the original).
- **Hand corrections**: click *Edit* and type the romaji a song actually uses (e.g. 時間 sung as *toki*).
- Display modes (Both / Romaji / Original), font size, copy romaji.

## Install (unpacked)

```bash
npm install
npm run build
```

Then open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the `dist` folder.
After rebuilding, press ↻ on the extension card **and refresh the YouTube Music tab**.

## Development

- `npm test` — romaji regression cases (`dev/cases.mjs`), LRC parsing, LRCLIB matching, title case, pronoun normalisation.
- `node test.mjs "<line>"` — print romaji for any line.
- `node dev/tokens.mjs "<text>"` — show kuromoji tokens.
- `dev/harness.html`, `dev/harness-notab.html` — fake YouTube Music pages for checking the UI (serve the repo root, e.g. `python3 -m http.server`).
- `node dev/build-kanji.mjs Unihan_Readings.txt` — regenerate `src/kanji-readings.js`.

| Path | What it does |
|---|---|
| `src/romaji.js` | Japanese line → romaji |
| `src/content.js` | Lyrics view, synced mode, Lyrics-tab panel, toolbar |
| `src/titles.js` | Romaji for song titles |
| `src/translate.js` | Gemini Nano / Translator API / language detection |
| `src/lrc.js` | LRC parsing and picking the right LRCLIB entry |
| `src/background.js` | Service worker that queries LRCLIB |

## Credits

- [kuromoji.js](https://github.com/takuyaa/kuromoji.js) (Apache-2.0) and its IPADIC dictionary
- [WanaKana](https://github.com/WaniKani/WanaKana) (MIT)
- Kanji readings from the Unicode [Unihan database](https://www.unicode.org/charts/unihan.html) ([Unicode License](https://www.unicode.org/license.txt))
- Lyrics from [LRCLIB](https://lrclib.net)

## License

MIT, see [LICENSE](LICENSE). `src/kanji-readings.js` is derived from Unicode data under the Unicode License.
