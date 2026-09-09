window.InstaAnalytics = window.InstaAnalytics || {};
(() => {
  const SESSION_KEY = "ia_supabase_session_v1";

  function getConfig() {
    const url = String(window.InstaAnalytics.config?.SUPABASE_URL || "").replace(/\/$/, "");
    const key = String(window.InstaAnalytics.config?.SUPABASE_PUBLISHABLE_KEY || "");
    return { url, key, configured: !!url && !!key };
  }

  async function saveSession(session) {
    await chrome.storage.local.set({ [SESSION_KEY]: session || null });
  }

  async function getSession() {
    const data = await chrome.storage.local.get(SESSION_KEY);
    const session = data[SESSION_KEY] || null;
    if (!session?.access_token) return null;

    if (session.expires_at && Date.now() >= session.expires_at * 1000 - 60_000 && session.refresh_token) {
      try {
        return await refreshSession(session.refresh_token);
      } catch {
        await saveSession(null);
        return null;
      }
    }

    return session;
  }

  async function authRequest(path, body) {
    const cfg = getConfig();
    if (!cfg.configured) throw new Error("Supabase ainda não foi configurado em src/config/app-config.js.");

    const response = await fetch(`${cfg.url}/auth/v1/${path}`, {
      method: "POST",
      headers: {
        apikey: cfg.key,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.msg || data?.message || data?.error_description || `Auth HTTP ${response.status}`);
    return data;
  }

  async function signIn(email, password) {
    const data = await authRequest("token?grant_type=password", { email, password });
    await saveSession(data);
    return data;
  }

  async function signUp(email, password) {
    const data = await authRequest("signup", { email, password });
    if (data?.access_token) await saveSession(data);
    return data;
  }

  async function refreshSession(refreshToken) {
    const data = await authRequest("token?grant_type=refresh_token", { refresh_token: refreshToken });
    await saveSession(data);
    return data;
  }

  async function signOut() {
    const cfg = getConfig();
    const session = await getSession();

    if (cfg.configured && session?.access_token) {
      await fetch(`${cfg.url}/auth/v1/logout`, {
        method: "POST",
        headers: {
          apikey: cfg.key,
          Authorization: `Bearer ${session.access_token}`
        }
      }).catch(() => {});
    }

    await saveSession(null);
  }

  Object.assign(window.InstaAnalytics, {
    getSupabaseConfig: getConfig,
    getAuthSession: getSession,
    signIn,
    signUp,
    signOut
  });
})();
