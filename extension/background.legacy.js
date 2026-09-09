chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url?.includes("instagram.com")) return;

  chrome.tabs.sendMessage(tab.id, { action: "toggle-panel" }, () => {
    void chrome.runtime.lastError;
  });
});