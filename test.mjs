import kuromoji from "kuromoji";
import { lineToRomaji } from "./src/romaji.js";
import cases from "./dev/cases.mjs";

// `node test.mjs` runs the regression cases; `node test.mjs <line>...` prints romaji for ad-hoc lines.
const adhoc = process.argv.slice(2);
kuromoji.builder({ dicPath: "node_modules/kuromoji/dict" }).build((err, tk) => {
  if (err) throw err;
  if (adhoc.length) {
    for (const l of adhoc) console.log(l, "=>", lineToRomaji(tk, l));
    return;
  }
  let failed = 0;
  for (const [input, want] of cases) {
    const got = lineToRomaji(tk, input);
    if (got !== want) {
      failed++;
      console.log(`FAIL ${input}\n  want: ${want}\n  got:  ${got}`);
    }
  }
  console.log(`${cases.length - failed}/${cases.length} passed`);
  process.exitCode = failed ? 1 : 0;
});
