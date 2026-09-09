chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url?.includes("instagram.com")) return;

  chrome.tabs.sendMessage(tab.id, { action: "toggle-panel" }, () => {
    void chrome.runtime.lastError;
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.action !== "open-external-url") return;

  try {
    const url = new URL(message.url);
    const allowed =
      url.protocol === "https:" &&
      (
        url.hostname === "mercadopago.com.br" ||
        url.hostname.endsWith(".mercadopago.com.br") ||
        url.hostname === "mercadopago.com" ||
        url.hostname.endsWith(".mercadopago.com")
      );

    if (allowed) chrome.tabs.create({ url: url.toString() });
  } catch {
    // URL inválida: não abre.
  }
});

