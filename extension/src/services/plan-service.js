window.InstaAnalytics = window.InstaAnalytics || {};
(() => {
  const IA = window.InstaAnalytics;
  const SETTINGS_CACHE_KEY = "ia_public_settings_v1";
  const SETTINGS_CACHE_MS = 5 * 60 * 1000;

  function defaults() { return { ...(IA.productDefaults || {}) }; }

  async function publicRequest(path, { method = "GET", body } = {}) {
    const cfg = IA.getSupabaseConfig?.() || { configured: false };
    if (!cfg.configured) throw new Error("Supabase não configurado.");
    const response = await fetch(`${cfg.url}/rest/v1/${path}`, {
      method,
      headers: { apikey: cfg.key, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) throw new Error(data?.message || data?.hint || `Supabase HTTP ${response.status}`);
    return data;
  }

  async function getProductSettings(force = false) {
    const cfg = IA.getSupabaseConfig?.() || { configured: false };
    if (!cfg.configured) return defaults();
    if (!force) {
      const cached = await chrome.storage.local.get(SETTINGS_CACHE_KEY);
      const entry = cached[SETTINGS_CACHE_KEY];
      if (entry?.value && Date.now() - Number(entry.savedAt || 0) < SETTINGS_CACHE_MS) return { ...defaults(), ...entry.value };
    }
    try {
      const rows = await publicRequest("app_settings?id=eq.main&select=*");
      const merged = { ...defaults(), ...(rows?.[0] || {}) };
      await chrome.storage.local.set({ [SETTINGS_CACHE_KEY]: { value: merged, savedAt: Date.now() } });
      return merged;
    } catch { return defaults(); }
  }

  async function getGuestAccess(instagramAccount, settings) {
    if (!instagramAccount?.userId || !instagramAccount?.username) {
      return { mode: "guest", planCode: "guest", allowed: false, syncAllowed: false, used: 0, limit: Number(settings.guest_collection_limit || 10), remaining: null, paidUntil: null, reason: "Detecte sua conta do Instagram para verificar as coletas gratuitas.", settings };
    }
    try {
      const rows = await publicRequest("rpc/get_guest_instagram_access", {
        method: "POST",
        body: { p_instagram_user_id: String(instagramAccount.userId), p_username: instagramAccount.username }
      });
      const row = Array.isArray(rows) ? rows[0] : rows;
      const limit = Number(row?.collection_limit || 0);
      const used = Number(row?.used_collections || 0);
      return { mode: "guest", planCode: "guest", allowed: !!row?.can_collect, syncAllowed: false, used, limit, remaining: limit <= 0 ? null : Math.max(0, limit - used), paidUntil: null, reason: row?.message || "", instagramUserId: String(instagramAccount.userId), instagramUsername: instagramAccount.username, settings };
    } catch (error) {
      return { mode: "guest", planCode: "guest", allowed: false, syncAllowed: false, used: 0, limit: Number(settings.guest_collection_limit || 10), remaining: null, paidUntil: null, reason: `Não foi possível validar a cota gratuita: ${error.message}`, settings };
    }
  }

  async function getAuthenticatedAccess() {
    const session = await IA.getAuthSession?.();
    if (!session?.user?.id) return null;
    try {
      const rows = await IA.supabaseRequest("rpc/get_my_access", { method: "POST", body: {} });
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (!row) throw new Error("Plano não retornado.");
      return { mode: "account", planCode: row.plan_code || "pending", allowed: !!row.can_collect, syncAllowed: ["free", "pro"].includes(row.plan_code), used: Number(row.used_collections || 0), limit: Number(row.collection_limit || 0), remaining: Number(row.collection_limit || 0) <= 0 ? null : Math.max(0, Number(row.collection_limit || 0) - Number(row.used_collections || 0)), paidUntil: row.paid_until || null, reason: row.message || "", proPrice: Number(row.pro_price_brl || 0), proDurationDays: Number(row.pro_duration_days || 30), freeEnabled: !!row.free_enabled, cooldownMinutes: Number(row.cooldown_minutes || 0) };
    } catch (error) {
      return { mode: "account", planCode: "error", allowed: false, syncAllowed: false, used: 0, limit: 0, remaining: 0, paidUntil: null, reason: `Não foi possível consultar o plano: ${error.message}` };
    }
  }

  async function getAccessState(instagramAccount = null) {
    const settings = await getProductSettings();
    const session = await IA.getAuthSession?.();
    if (!session?.user?.id) return getGuestAccess(instagramAccount, settings);
    const account = await getAuthenticatedAccess();
    if (account && ["free", "pro"].includes(account.planCode)) return { ...account, settings };
    const guest = await getGuestAccess(instagramAccount, settings);
    if (guest.allowed) return { ...guest, authenticatedButUsingGuest: true, accountPlanCode: account?.planCode || "pending", accountReason: account?.reason || "" };
    return { ...(account || guest), settings };
  }

  async function checkCollectionPermission(instagramAccount) {
    const access = await getAccessState(instagramAccount);
    if (access.allowed) return access;
    const error = new Error(access.reason || (access.planCode === "pending" ? "Sua conta ainda não possui um plano ativo." : "Limite de coletas atingido."));
    error.code = "COLLECTION_LIMIT"; error.access = access; throw error;
  }

  async function commitCollectionUse(access, snapshot) {
    if (!access || !snapshot) return null;
    if (access.mode === "guest") {
      const rows = await publicRequest("rpc/register_guest_instagram_collection", { method: "POST", body: { p_instagram_user_id: String(snapshot.userId), p_username: snapshot.username } });
      return Array.isArray(rows) ? rows[0] : rows;
    }
    const result = await IA.supabaseRequest("rpc/register_collection_use", { method: "POST", body: { p_account_username: snapshot.username, p_snapshot_local_id: snapshot.id } });
    return Array.isArray(result) ? result[0] : result;
  }

  function quotaText(access) {
    if (!access) return "";
    const used = Number(access.used || 0), limit = Number(access.limit || 0);
    const unlimited = access.planCode === "pro" && access.settings?.pro_unlimited === true;
    if (unlimited) return `Ilimitado · ${used} coletas realizadas`;
    if (limit <= 0) return `${used} coletas usadas`;
    return `${used}/${limit} coletas usadas`;
  }

  Object.assign(IA, { getProductSettings, getGuestUsage: async () => null, getCollectionAccess: getAccessState, checkCollectionPermission, commitCollectionUse, quotaText });
})();

