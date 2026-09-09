window.InstaAnalytics = window.InstaAnalytics || {};
(() => {
  const IA = window.InstaAnalytics;
  const ANNOTATIONS_KEY = "ia_annotations_v2";
  const NOTIFICATIONS_KEY = "ia_notifications_v2";

  const safeKey = (user) => String(user?.id || user?.username || "").toLowerCase();

  async function authRest(path, { method = "GET", body, prefer } = {}) {
    const cfg = IA.getSupabaseConfig?.() || { configured: false };
    const session = await IA.getAuthSession?.();
    if (!cfg.configured || !session?.access_token) throw new Error("Login Supabase necessário.");
    const response = await fetch(`${cfg.url}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
        ...(prefer ? { Prefer: prefer } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) throw new Error(data?.message || data?.hint || `Supabase HTTP ${response.status}`);
    return data;
  }

  async function loadLocalAnnotations() {
    const data = await chrome.storage.local.get(ANNOTATIONS_KEY);
    return data[ANNOTATIONS_KEY] || {};
  }

  async function getAnnotation(user) {
    const key = safeKey(user);
    const local = await loadLocalAnnotations();
    const base = local[key] || { watchlisted: false, tags: [], note: "" };
    const session = await IA.getAuthSession?.();
    if (!session?.user?.id || !user?.id) return base;
    try {
      const rows = await authRest(`contact_annotations?instagram_user_id=eq.${encodeURIComponent(String(user.id))}&select=*`);
      const row = rows?.[0];
      if (!row) return base;
      return { watchlisted: !!row.watchlisted, tags: Array.isArray(row.tags) ? row.tags : [], note: row.note || "" };
    } catch { return base; }
  }

  async function saveAnnotation(user, value) {
    const key = safeKey(user);
    if (!key) throw new Error("Usuário inválido.");
    const local = await loadLocalAnnotations();
    local[key] = {
      watchlisted: !!value.watchlisted,
      tags: [...new Set((value.tags || []).map((x) => String(x).trim()).filter(Boolean))],
      note: String(value.note || "").trim(),
      user: { id: String(user.id || ""), username: user.username || "", fullName: user.fullName || "", profilePic: user.profilePic || "" },
      updatedAt: Date.now()
    };
    await chrome.storage.local.set({ [ANNOTATIONS_KEY]: local });

    const session = await IA.getAuthSession?.();
    if (session?.user?.id && user?.id) {
      try {
        await authRest("contact_annotations?on_conflict=owner_id,instagram_user_id", {
          method: "POST",
          prefer: "resolution=merge-duplicates,return=minimal",
          body: {
            owner_id: session.user.id,
            instagram_user_id: String(user.id),
            username: user.username || "",
            full_name: user.fullName || "",
            profile_pic: user.profilePic || "",
            watchlisted: !!value.watchlisted,
            tags: local[key].tags,
            note: local[key].note,
            updated_at: new Date().toISOString()
          }
        });
      } catch (error) { console.warn("[Insta Analytics] sync annotation:", error.message); }
    }
    return local[key];
  }

  async function listWatchlist() {
    const local = await loadLocalAnnotations();
    const list = Object.values(local).filter((x) => x?.watchlisted && x.user);
    const session = await IA.getAuthSession?.();
    if (!session?.user?.id) return list;
    try {
      const rows = await authRest("contact_annotations?watchlisted=eq.true&select=*&order=updated_at.desc");
      if (!Array.isArray(rows)) return list;
      return rows.map((row) => ({
        watchlisted: true,
        tags: row.tags || [],
        note: row.note || "",
        user: { id: row.instagram_user_id, username: row.username, fullName: row.full_name, profilePic: row.profile_pic }
      }));
    } catch { return list; }
  }

  function eventLabel(type) {
    return {
      unfollows: "deixou de seguir você",
      newFollowers: "começou a seguir você",
      youStartedFollowing: "você começou a seguir",
      youUnfollowed: "você deixou de seguir"
    }[type] || type;
  }

  async function recordNotificationsForSnapshot(snapshot) {
    if (!snapshot?.id) return [];
    const confirmed = snapshot.differences || {};
    const localData = await chrome.storage.local.get(NOTIFICATIONS_KEY);
    const current = Array.isArray(localData[NOTIFICATIONS_KEY]) ? localData[NOTIFICATIONS_KEY] : [];
    const seen = new Set(current.map((n) => n.eventKey));
    const created = [];

    for (const type of ["unfollows", "newFollowers", "youStartedFollowing", "youUnfollowed"]) {
      for (const user of confirmed[type] || []) {
        const eventKey = `${snapshot.id}:${type}:${safeKey(user)}`;
        if (seen.has(eventKey)) continue;
        const item = {
          eventKey, snapshotId: snapshot.id, type,
          user: { id: String(user.id || ""), username: user.username || "", fullName: user.fullName || "", profilePic: user.profilePic || "" },
          label: eventLabel(type), createdAt: Date.now(), readAt: null
        };
        current.unshift(item); created.push(item); seen.add(eventKey);
      }
    }
    await chrome.storage.local.set({ [NOTIFICATIONS_KEY]: current.slice(0, 500) });

    const session = await IA.getAuthSession?.();
    if (session?.user?.id && created.length) {
      try {
        await authRest("analytics_notifications?on_conflict=owner_id,event_key", {
          method: "POST", prefer: "resolution=ignore-duplicates,return=minimal",
          body: created.map((n) => ({
            owner_id: session.user.id,
            event_key: n.eventKey,
            event_type: n.type,
            instagram_user_id: n.user.id || null,
            username: n.user.username,
            full_name: n.user.fullName,
            snapshot_local_id: snapshot.id,
            payload: n,
            created_at: new Date(n.createdAt).toISOString()
          }))
        });
      } catch (error) { console.warn("[Insta Analytics] sync notification:", error.message); }
    }
    return created;
  }

  async function listNotifications() {
    const localData = await chrome.storage.local.get(NOTIFICATIONS_KEY);
    return Array.isArray(localData[NOTIFICATIONS_KEY]) ? localData[NOTIFICATIONS_KEY] : [];
  }

  async function markNotificationsRead() {
    const list = await listNotifications();
    const now = Date.now();
    for (const n of list) if (!n.readAt) n.readAt = now;
    await chrome.storage.local.set({ [NOTIFICATIONS_KEY]: list });
    return list;
  }

  function downloadText(filename, text, mime = "text/plain") {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  function exportHistoryJson(username, history) {
    downloadText(`insta-analytics-${username}-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify({ username, exportedAt: new Date().toISOString(), snapshots: history }, null, 2), "application/json");
  }

  function csvEscape(value) {
    const s = String(value ?? "");
    return `"${s.replaceAll('"', '""')}"`;
  }

  function exportChangesCsv(username, history) {
    const rows = [["data","tipo","instagram_user_id","username","nome"]];
    for (const snapshot of [...history].reverse()) {
      for (const type of ["unfollows", "newFollowers", "youStartedFollowing", "youUnfollowed"]) {
        for (const user of snapshot?.differences?.[type] || []) {
          rows.push([new Date(snapshot.createdAt).toISOString(), type, user.id || "", user.username || "", user.fullName || ""]);
        }
      }
    }
    const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
    downloadText(`insta-analytics-mudancas-${username}-${new Date().toISOString().slice(0,10)}.csv`, csv, "text/csv;charset=utf-8");
  }

  async function isAdmin() {
    try {
      const cfg = IA.getSupabaseConfig?.();
      const session = await IA.getAuthSession?.();
      if (!cfg?.configured || !session?.access_token) return false;
      const response = await fetch(`${cfg.url}/rest/v1/rpc/is_admin`, {
        method: "POST",
        headers: { apikey: cfg.key, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: "{}"
      });
      if (!response.ok) return false;
      return !!(await response.json());
    } catch { return false; }
  }

  async function adminRpc(name, body = {}) {
    const cfg = IA.getSupabaseConfig?.();
    const session = await IA.getAuthSession?.();
    if (!cfg?.configured || !session?.access_token) throw new Error("Login necessário.");
    const response = await fetch(`${cfg.url}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: cfg.key, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) throw new Error(data?.message || `Admin HTTP ${response.status}`);
    return data;
  }

  Object.assign(IA, {
    getAnnotation, saveAnnotation, listWatchlist,
    recordNotificationsForSnapshot, listNotifications, markNotificationsRead,
    exportHistoryJson, exportChangesCsv,
    isAdmin, adminRpc
  });
})();
