window.InstaAnalytics = window.InstaAnalytics || {};
(() => {
  const IA = window.InstaAnalytics;

  async function createProCheckout() {
    const cfg = IA.getSupabaseConfig();
    const session = await IA.getAuthSession();

    if (!cfg.configured) throw new Error("Supabase não configurado.");
    if (!session?.access_token) throw new Error("Crie sua conta ou faça login antes de assinar.");

    const response = await fetch(`${cfg.url}/functions/v1/create-mercadopago-checkout`, {
      method: "POST",
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ plan: "pro" })
    });

    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }

    if (!response.ok) {
      throw new Error(data?.message || data?.error || `Checkout HTTP ${response.status}`);
    }

    const checkoutUrl = data?.checkout_url || data?.init_point;
    if (!checkoutUrl) throw new Error("Mercado Pago não retornou a URL do checkout.");

    chrome.runtime.sendMessage({ action: "open-external-url", url: checkoutUrl });
    return data;
  }

  Object.assign(IA, { createProCheckout });
})();

