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
const keyStatus = document.getElementById("claude-status");
const saveBtn = document.getElementById("claude-save");
const count = document.getElementById("cache-count");
const fileInput = document.getElementById("cache-file");
const send = (msg) => chrome.runtime.sendMessage(msg);
// An unanswered message means the background worker is still the old build: Chrome only swaps it on reload.
const OUTDATED = "Reload the extension in chrome://extensions (↻), then save again";
function ask(msg, ms) {
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ error: "No answer from Anthropic after 25 s" }), ms));
  return Promise.race([send(msg).then((r) => r ?? { error: OUTDATED }, () => ({ error: OUTDATED })), timeout]);
}

function paintKey(key, status) {
  const bad = Boolean(key) && status?.ok === false;
  keyState.textContent = !key ? "Off" : bad ? "Error" : "On";
  keyState.className = !key ? "" : bad ? "bad" : "on";
  keyStatus.className = "key-status " + (!key ? "" : bad ? "bad" : status?.ok ? "ok" : "");
  keyStatus.textContent = !key ? "" : status ? (status.ok ? "✓ " : "✕ ") + status.message : "Not checked yet";
}

async function refreshKey() {
  const { claudeKey, claudeStatus } = await chrome.storage.local.get(["claudeKey", "claudeStatus"]);
  paintKey(claudeKey, claudeStatus);
  return claudeKey;
}

async function paintCount() {
  const { entries = {} } = (await send({ type: "claude-cache-export" }).catch(() => null)) ?? {};
  const n = Object.keys(entries).filter((k) => k.startsWith("tr:")).length;
  count.textContent = n === 1 ? "1 song saved" : `${n} songs saved`;
}

refreshKey().then((key) => {
  keyInput.value = key ?? "";
  if (!key) document.getElementById("claude").open = true;
});
paintCount();
// A translation that fails (credit ran out, key revoked) updates the status while the popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.claudeStatus || changes.claudeKey)) refreshKey();
  if (area === "local" && Object.keys(changes).some((k) => k.startsWith("tr:"))) paintCount();
});

saveBtn.addEventListener("click", async () => {
  const key = keyInput.value.trim();
  if (!key) {
    await chrome.storage.local.remove(["claudeKey", "claudeStatus"]);
    return refreshKey();
  }
  saveBtn.disabled = true;
  keyStatus.className = "key-status";
  keyStatus.textContent = "Checking key…";
  const reply = await ask({ type: "claude-check-key", key }, 25_000);
  // Save even a failing key: the problem may be temporary (offline), and the status says what's wrong.
  // The worker records its own result; a reply it never sent is recorded here.
  if (!("ok" in reply)) await chrome.storage.local.set({ claudeStatus: { ok: false, message: reply.error, at: Date.now() } });
  await chrome.storage.local.set({ claudeKey: key });
  saveBtn.disabled = false;
  await refreshKey();
  if (reply.ok) keyStatus.textContent = "✓ Key works. Lyrics already open are re-translated now.";
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
  if (!confirm("Delete all saved Claude translations and song names? Songs will be sent to Claude (and billed) again.")) return;
  await send({ type: "claude-cache-clear" });
  paintCount();
});
