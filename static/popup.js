const defaults = { mode: "below", fontSize: 16, translate: false, lang: "id", titles: true, synced: true };
const groups = document.querySelectorAll(".seg");
const switches = document.querySelectorAll(".switch input");
const slider = document.getElementById("font-size");
const sliderValue = document.getElementById("font-size-value");

function paint(settings) {
  groups.forEach((g) =>
    g.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.value === settings[g.dataset.key])))
  );
  switches.forEach((s) => (s.checked = Boolean(settings[s.dataset.key])));
  slider.value = settings.fontSize;
  sliderValue.textContent = settings.fontSize + " px";
}

chrome.storage.sync.get(defaults, paint);
chrome.storage.onChanged.addListener(() => chrome.storage.sync.get(defaults, paint));
groups.forEach((g) =>
  g.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) chrome.storage.sync.set({ [g.dataset.key]: b.dataset.value });
  })
);
switches.forEach((s) => s.addEventListener("change", () => chrome.storage.sync.set({ [s.dataset.key]: s.checked })));
slider.addEventListener("input", () => {
  sliderValue.textContent = slider.value + " px";
  chrome.storage.sync.set({ fontSize: Number(slider.value) });
});

// ---- Claude translation ----
const keyInput = document.getElementById("claude-key");
const keyState = document.getElementById("claude-state");
const count = document.getElementById("cache-count");
const fileInput = document.getElementById("cache-file");
const send = (msg) => chrome.runtime.sendMessage(msg);

function paintKey(key) {
  keyInput.value = key ?? "";
  keyState.textContent = key ? "On" : "Off";
  keyState.classList.toggle("on", Boolean(key));
}

async function paintCount() {
  const { entries = {} } = await send({ type: "claude-cache-export" });
  const n = Object.keys(entries).length;
  count.textContent = n === 1 ? "1 song saved" : `${n} songs saved`;
}

chrome.storage.local.get("claudeKey", ({ claudeKey }) => {
  paintKey(claudeKey);
  if (!claudeKey) document.getElementById("claude").open = true;
});
paintCount();

document.getElementById("claude-save").addEventListener("click", async () => {
  const key = keyInput.value.trim();
  if (key) await chrome.storage.local.set({ claudeKey: key });
  else await chrome.storage.local.remove("claudeKey");
  paintKey(key);
});

document.getElementById("cache-export").addEventListener("click", async () => {
  const { entries = {} } = await send({ type: "claude-cache-export" });
  const url = URL.createObjectURL(new Blob([JSON.stringify(entries)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: "romaji-lyrics-translations.json" });
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("cache-import").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  fileInput.value = "";
  if (!file) return;
  try {
    const { count: n } = await send({ type: "claude-cache-import", entries: JSON.parse(await file.text()) });
    count.textContent = `Imported ${n} songs`;
    setTimeout(paintCount, 1500);
  } catch {
    count.textContent = "Not a translations file";
  }
});

document.getElementById("cache-clear").addEventListener("click", async () => {
  if (!confirm("Delete all saved Claude translations? Songs will be translated (and billed) again.")) return;
  await send({ type: "claude-cache-clear" });
  paintCount();
});
