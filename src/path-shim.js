// kuromoji calls path.join(dicPath, file); the real join collapses "chrome-extension://" into "chrome-extension:/".
export function join(dir, file) {
  return dir.replace(/\/+$/, "") + "/" + file;
}
export default { join };
