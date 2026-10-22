import kuromoji from "kuromoji";

let promise = null;
let ready = false;

// After the extension is reloaded, scripts left in open tabs lose access to extension files.
export const extensionAlive = () => Boolean(globalThis.chrome?.runtime?.id);

export function getTokenizer() {
  if (!promise && !extensionAlive()) return Promise.reject(new Error("Extension was reloaded; refresh this tab"));
  promise ??= new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath: chrome.runtime.getURL("dict/") }).build((err, tk) => {
      if (err) return reject(err);
      ready = true;
      resolve(tk);
    });
  });
  return promise;
}

export const tokenizerReady = () => ready;
