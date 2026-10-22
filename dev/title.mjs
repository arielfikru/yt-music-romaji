// Prints the romanised title for each argument: node dev/title.mjs "<title>"...
import kuromoji from "kuromoji";
import { titleRomaji } from "../src/titles.js";
kuromoji.builder({ dicPath: "node_modules/kuromoji/dict" }).build((err, tk) => {
  if (err) throw err;
  for (const t of process.argv.slice(2)) console.log(t, "=>", titleRomaji(tk, t));
});
