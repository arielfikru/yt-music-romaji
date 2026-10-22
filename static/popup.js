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
