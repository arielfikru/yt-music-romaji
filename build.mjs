import { build } from "esbuild";
import { cpSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
cpSync("static", "dist", { recursive: true });
cpSync("node_modules/kuromoji/dict", "dist/dict", { recursive: true });
await build({
  entryPoints: ["src/content.js", "src/background.js"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  alias: { path: "./src/path-shim.js" },
  outdir: "dist",
  logLevel: "warning",
});
console.log("built dist/");
