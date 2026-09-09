window.InstaAnalytics = window.InstaAnalytics || {};
(() => {
  const IA = window.InstaAnalytics;

  async function request(path, { method = "GET", body, prefer = "" } = {}) {
    const cfg = IA.getSupabaseConfig();
    const session = await IA.getAuthSession();

    if (!cfg.configured) throw new Error("Supabase não configurado.");
    if (!session?.access_token || !session?.user?.id) throw new Error("Faça login no Supabase primeiro.");

    const headers = {
      apikey: cfg.key,
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json"
    };
    if (prefer) headers.Prefer = prefer;

    const response = await fetch(`${cfg.url}/rest/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    if (!response.ok) {
      const message = data?.message || data?.hint || data?.details || `Supabase HTTP ${response.status}`;
      throw new Error(message);
    }

    return data;
  }

  async function syncSnapshot(snapshot) {
    const session = await IA.getAuthSession();
    if (!session?.user?.id) return { synced: false, reason: "not_authenticated" };

    const ownerId = session.user.id;
    const profile = snapshot.profileInfo || {};

    const accountRows = await request("instagram_accounts?on_conflict=owner_id,instagram_user_id", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body: [{
        owner_id: ownerId,
        instagram_user_id: String(snapshot.userId),
        username: snapshot.username,
        full_name: profile.fullName || "",
        profile_pic_url: profile.profilePic || "",
        is_private: !!profile.isPrivate,
        is_verified: !!profile.isVerified,
        last_collection_at: new Date(snapshot.createdAt).toISOString()
      }]
    });

    const account = Array.isArray(accountRows) ? accountRows[0] : null;
    if (!account?.id) throw new Error("Supabase não retornou o ID da conta do Instagram.");

    const runRows = await request("collection_runs", {
      method: "POST",
      prefer: "return=representation",
      body: [{
        owner_id: ownerId,
        account_id: account.id,
        local_snapshot_id: snapshot.id,
        quality_status: snapshot.quality?.status || "unknown",
        comparison_eligible: !!snapshot.comparisonEligible,
        followers_count: snapshot.followers?.length || 0,
        following_count: snapshot.following?.length || 0,
        expected_followers: snapshot.quality?.expectedFollowers ?? null,
        expected_following: snapshot.quality?.expectedFollowing ?? null,
        previous_snapshot_local_id: snapshot.previousEligibleId || null,
        diff_summary: snapshot.diffSummary || {},
        created_at: new Date(snapshot.createdAt).toISOString()
      }]
    });

    const run = Array.isArray(runRows) ? runRows[0] : null;

    await request("snapshots?on_conflict=owner_id,local_snapshot_id", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: [{
        owner_id: ownerId,
        account_id: account.id,
        collection_run_id: run?.id || null,
        local_snapshot_id: snapshot.id,
        username: snapshot.username,
        instagram_user_id: String(snapshot.userId),
        profile_info: snapshot.profileInfo || {},
        followers: snapshot.followers || [],
        following: snapshot.following || [],
        differences: snapshot.differences || {},
        quality: snapshot.quality || {},
        comparison_eligible: !!snapshot.comparisonEligible,
        created_at: new Date(snapshot.createdAt).toISOString()
      }]
    });

    return { synced: true, accountId: account.id, runId: run?.id || null };
  }

  async function loadRemoteSnapshots(username) {
    const session = await IA.getAuthSession();
    if (!session?.user?.id) return [];

    const account = await request(
      `instagram_accounts?owner_id=eq.${encodeURIComponent(session.user.id)}&username=eq.${encodeURIComponent(IA.normalizeAccountKey(username))}&select=id&limit=1`
    );

    const accountId = account?.[0]?.id;
    if (!accountId) return [];

    return await request(
      `snapshots?account_id=eq.${encodeURIComponent(accountId)}&select=*&order=created_at.desc&limit=50`
    );
  }

  Object.assign(IA, { supabaseRequest: request, syncSnapshotToSupabase: syncSnapshot, loadRemoteSnapshots });
})();
