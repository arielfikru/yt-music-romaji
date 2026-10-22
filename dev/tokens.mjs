import kuromoji from "kuromoji";
kuromoji.builder({ dicPath: process.cwd() + "/node_modules/kuromoji/dict" }).build((e, tk) => {
  for (const s of process.argv.slice(2)) console.log(s, tk.tokenize(s).map(t => `${t.surface_form}[${t.pos}/${t.reading ?? "-"}/${t.word_type}]`).join(" "));
});
