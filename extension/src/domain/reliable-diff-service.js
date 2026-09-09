window.InstaAnalytics = window.InstaAnalytics || {};
(() => {
  const IA = window.InstaAnalytics;

  function normalizeUser(raw) {
    if (!raw) return null;
    if (typeof raw === "string") return { id: "", username: raw.trim(), fullName: "", profilePic: "" };
    return {
      id: String(raw.id || raw.pk || "").trim(),
      username: String(raw.username || "").trim(),
      fullName: String(raw.fullName || raw.full_name || "").trim(),
      profilePic: String(raw.profilePic || raw.profile_pic_url || "").trim()
    };
  }

  function normalizeList(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of list) {
      const u = normalizeUser(raw);
      if (!u?.username) continue;
      const key = u.id ? `id:${u.id}` : `u:${u.username.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(u);
    }
    return out;
  }

  function isEligible(snapshot) {
    if (!snapshot) return false;
    if (snapshot.comparisonEligible === true) return true;
    const status = snapshot?.quality?.status || "unknown";
    return status === "valid" || status === "unverified";
  }

  function buildIdentityContext(lists) {
    const usernameToId = new Map();
    const byId = new Map();
    const byUsername = new Map();

    for (const list of lists) {
      for (const raw of normalizeList(list)) {
        const username = raw.username.toLowerCase();
        if (raw.id) {
          usernameToId.set(username, raw.id);
          const prev = byId.get(raw.id) || {};
          byId.set(raw.id, { ...prev, ...raw, id: raw.id });
        }
        const prevUser = byUsername.get(username) || {};
        byUsername.set(username, { ...prevUser, ...raw });
      }
    }

    function keyOf(raw) {
      const u = normalizeUser(raw);
      if (!u) return "";
      if (u.id) return `id:${u.id}`;
      const mapped = usernameToId.get(u.username.toLowerCase());
      return mapped ? `id:${mapped}` : `u:${u.username.toLowerCase()}`;
    }

    function representative(key) {
      if (key.startsWith("id:")) {
        const id = key.slice(3);
        return normalizeUser(byId.get(id)) || { id, username: "", fullName: "", profilePic: "" };
      }
      const username = key.slice(2);
      return normalizeUser(byUsername.get(username)) || { id: "", username, fullName: "", profilePic: "" };
    }

    function setOf(list) {
      return new Set(normalizeList(list).map(keyOf).filter(Boolean));
    }

    function mapOf(list) {
      const map = new Map();
      for (const u of normalizeList(list)) {
        const k = keyOf(u);
        if (k) map.set(k, u);
      }
      return map;
    }

    return { keyOf, representative, setOf, mapOf };
  }

  function diffTransition(beforeList, afterList, ctx) {
    const before = ctx.setOf(beforeList);
    const after = ctx.setOf(afterList);
    const beforeMap = ctx.mapOf(beforeList);
    const afterMap = ctx.mapOf(afterList);

    const entered = [];
    const exited = [];
    for (const key of after) if (!before.has(key)) entered.push(afterMap.get(key) || ctx.representative(key));
    for (const key of before) if (!after.has(key)) exited.push(beforeMap.get(key) || ctx.representative(key));
    return { entered, exited };
  }

  function confirmTransition(olderList, candidateList, currentList, ctx) {
    const older = ctx.setOf(olderList);
    const candidate = ctx.setOf(candidateList);
    const current = ctx.setOf(currentList);
    const olderMap = ctx.mapOf(olderList);
    const candidateMap = ctx.mapOf(candidateList);
    const currentMap = ctx.mapOf(currentList);

    const entered = [];
    const exited = [];

    // ausente -> presente -> presente
    for (const key of candidate) {
      if (!older.has(key) && current.has(key)) {
        entered.push(currentMap.get(key) || candidateMap.get(key) || ctx.representative(key));
      }
    }

    // presente -> ausente -> ausente
    for (const key of older) {
      if (!candidate.has(key) && !current.has(key)) {
        exited.push(olderMap.get(key) || ctx.representative(key));
      }
    }

    return { entered, exited };
  }

  function currentNotFollowingBack(snapshot, ctx) {
    const followers = ctx.setOf(snapshot?.followers || []);
    const followingMap = ctx.mapOf(snapshot?.following || []);
    return [...followingMap.entries()]
      .filter(([key]) => !followers.has(key))
      .map(([, user]) => user);
  }

  function emptyDiff() {
    return {
      notFollowingBack: [],
      unfollows: [],
      newFollowers: [],
      youUnfollowed: [],
      youStartedFollowing: []
    };
  }

  function buildReliableDiff(current, existingHistory = []) {
    const eligible = (Array.isArray(existingHistory) ? existingHistory : [])
      .filter((s) => s && s.id !== current?.id && isEligible(s))
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

    const previous = eligible[0] || null;
    const older = eligible[1] || null;
    const currentEligible = isEligible(current);

    const allLists = [
      current?.followers, current?.following,
      previous?.followers, previous?.following,
      older?.followers, older?.following
    ];
    const ctx = buildIdentityContext(allLists);
    const differences = emptyDiff();
    const pendingDifferences = emptyDiff();
    differences.notFollowingBack = currentEligible ? currentNotFollowingBack(current, ctx) : [];

    if (!currentEligible) {
      return {
        baseline: false,
        cautiousMode: true,
        previous,
        older,
        differences,
        pendingDifferences,
        reason: "A coleta atual foi marcada como suspeita e não pode confirmar mudanças."
      };
    }

    if (!previous) {
      return { baseline: true, cautiousMode: false, previous: null, older: null, differences, pendingDifferences, reason: "Primeiro baseline elegível." };
    }

    // Mudanças entre a coleta anterior e a atual ficam PENDENTES.
    const pendingFollowers = diffTransition(previous.followers, current.followers, ctx);
    const pendingFollowing = diffTransition(previous.following, current.following, ctx);
    pendingDifferences.newFollowers = pendingFollowers.entered;
    pendingDifferences.unfollows = pendingFollowers.exited;
    pendingDifferences.youStartedFollowing = pendingFollowing.entered;
    pendingDifferences.youUnfollowed = pendingFollowing.exited;

    if (!older) {
      return {
        baseline: false,
        awaitingConfirmation: true,
        cautiousMode: false,
        previous,
        older: null,
        differences,
        pendingDifferences,
        reason: "Mudanças detectadas aguardam uma coleta adicional para confirmação."
      };
    }

    // Só confirma a mudança que aconteceu na coleta anterior se ela persistir agora.
    const confirmedFollowers = confirmTransition(older.followers, previous.followers, current.followers, ctx);
    const confirmedFollowing = confirmTransition(older.following, previous.following, current.following, ctx);
    differences.newFollowers = confirmedFollowers.entered;
    differences.unfollows = confirmedFollowers.exited;
    differences.youStartedFollowing = confirmedFollowing.entered;
    differences.youUnfollowed = confirmedFollowing.exited;

    return {
      baseline: false,
      awaitingConfirmation: false,
      cautiousMode: false,
      previous,
      older,
      differences,
      pendingDifferences,
      confirmedFromSnapshotId: previous.id || null,
      confirmedFromCreatedAt: previous.createdAt || null,
      reason: "Mudanças exibidas somente após confirmação em duas coletas consecutivas."
    };
  }

  function attachReliableSnapshotDiff(snapshot, result) {
    const d = result?.differences || emptyDiff();
    const p = result?.pendingDifferences || emptyDiff();
    snapshot.differences = d;
    snapshot.pendingDifferences = p;
    snapshot.previousEligibleId = result?.previous?.id || null;
    snapshot.reliableMeta = {
      version: 2,
      confirmationRuns: 2,
      awaitingConfirmation: !!result?.awaitingConfirmation,
      confirmedFromSnapshotId: result?.confirmedFromSnapshotId || null,
      confirmedFromCreatedAt: result?.confirmedFromCreatedAt || null,
      reason: result?.reason || ""
    };
    snapshot.diffSummary = {
      baseline: !!result?.baseline,
      newFollowers: d.newFollowers.length,
      unfollows: d.unfollows.length,
      youStartedFollowing: d.youStartedFollowing.length,
      youUnfollowed: d.youUnfollowed.length,
      pendingNewFollowers: p.newFollowers.length,
      pendingUnfollows: p.unfollows.length,
      pendingYouStartedFollowing: p.youStartedFollowing.length,
      pendingYouUnfollowed: p.youUnfollowed.length
    };
    return snapshot;
  }

  function rebuildReliableHistory(history = []) {
    const chronological = [...history].sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    const rebuilt = [];
    for (const snapshot of chronological) {
      const clone = { ...snapshot };
      const prior = [...rebuilt].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
      attachReliableSnapshotDiff(clone, buildReliableDiff(clone, prior));
      rebuilt.push(clone);
    }
    return rebuilt.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  }

  function relationState(snapshot, user) {
    if (!snapshot || !user) return { followsYou: false, youFollow: false };
    const ctx = buildIdentityContext([snapshot.followers, snapshot.following, [user]]);
    const key = ctx.keyOf(user);
    return {
      followsYou: ctx.setOf(snapshot.followers).has(key),
      youFollow: ctx.setOf(snapshot.following).has(key)
    };
  }

  function compareSnapshotPair(older, newer) {
    if (!older || !newer) return null;
    const ctx = buildIdentityContext([older.followers, older.following, newer.followers, newer.following]);
    const followers = diffTransition(older.followers, newer.followers, ctx);
    const following = diffTransition(older.following, newer.following, ctx);
    return {
      newFollowers: followers.entered,
      unfollows: followers.exited,
      youStartedFollowing: following.entered,
      youUnfollowed: following.exited,
      followersDelta: Number(newer.followers?.length || 0) - Number(older.followers?.length || 0),
      followingDelta: Number(newer.following?.length || 0) - Number(older.following?.length || 0)
    };
  }

  function getAnalytics(history = []) {
    const ordered = [...history].filter(isEligible).sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    if (!ordered.length) return null;
    const first = ordered[0];
    const latest = ordered[ordered.length - 1];
    const latestCtx = buildIdentityContext([latest.followers, latest.following]);
    const followers = latestCtx.setOf(latest.followers);
    const following = latestCtx.setOf(latest.following);
    let mutual = 0;
    for (const key of following) if (followers.has(key)) mutual += 1;
    const notFollowingBack = Math.max(0, following.size - mutual);
    const youDontFollowBack = Math.max(0, followers.size - mutual);
    const reciprocity = following.size > 0 ? (mutual / following.size) * 100 : 0;

    const totals = { unfollows: 0, newFollowers: 0, youStartedFollowing: 0, youUnfollowed: 0 };
    for (const s of ordered) {
      const ds = s.diffSummary || {};
      totals.unfollows += Number(ds.unfollows || 0);
      totals.newFollowers += Number(ds.newFollowers || 0);
      totals.youStartedFollowing += Number(ds.youStartedFollowing || 0);
      totals.youUnfollowed += Number(ds.youUnfollowed || 0);
    }

    return {
      first, latest,
      followersDelta: Number(latest.followers?.length || 0) - Number(first.followers?.length || 0),
      followingDelta: Number(latest.following?.length || 0) - Number(first.following?.length || 0),
      mutual, notFollowingBack, youDontFollowBack, reciprocity,
      totals,
      series: ordered.map((s) => ({ createdAt: s.createdAt, followers: s.followers?.length || 0, following: s.following?.length || 0 }))
    };
  }

  function getSilentUnfollows(snapshot) {
    if (!snapshot) return [];
    const ctx = buildIdentityContext([snapshot.following, snapshot?.differences?.unfollows || []]);
    const following = ctx.setOf(snapshot.following);
    return (snapshot?.differences?.unfollows || []).filter((u) => following.has(ctx.keyOf(u)));
  }

  Object.assign(IA, {
    buildReliableDiff,
    attachReliableSnapshotDiff,
    rebuildReliableHistory,
    relationState,
    compareSnapshotPair,
    getAnalytics,
    getSilentUnfollows
  });
})();
