(() => {
  if (window.__gbcProbeBridge) return;
  window.__gbcProbeBridge = true;
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "__gbc_probe__") return;
    try {
      chrome.runtime.sendMessage({ type: "gbc-probe", data });
    } catch {
      // ignore
    }
  });
})();
