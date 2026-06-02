const keyInput = document.getElementById("apiKey");
const thrInput = document.getElementById("thresholds");
const autoInput = document.getElementById("autoShow");
const status = document.getElementById("status");

// Load saved values.
chrome.storage.sync.get(["apiKey", "thresholds", "autoShow"], (data) => {
  keyInput.value = data.apiKey || "";
  thrInput.value = (data.thresholds || [1000000, 10000000]).join(", ");
  autoInput.checked = data.autoShow !== false; // default ON
});

document.getElementById("save").addEventListener("click", () => {
  const apiKey = keyInput.value.trim();
  const thresholds = thrInput.value
    .split(",")
    .map((s) => Number(s.replace(/[_,\s]/g, "")))
    .filter((n) => n > 0)
    .sort((a, b) => a - b);

  chrome.storage.sync.set(
    {
      apiKey,
      thresholds: thresholds.length ? thresholds : [1000000, 10000000],
      autoShow: autoInput.checked,
    },
    () => {
      status.textContent = "Saved ✓";
      setTimeout(() => (status.textContent = ""), 1500);
    }
  );
});
