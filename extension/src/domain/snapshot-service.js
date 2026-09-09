window.InstaAnalytics = window.InstaAnalytics || {};
(() => {
  const IA = window.InstaAnalytics;

  function createSnapshot({ username, userId, profileInfo, followersResult, followingResult }) {
    const followers = IA.normalizeUsers(followersResult?.users || followersResult || []);
    const following = IA.normalizeUsers(followingResult?.users || followingResult || []);

    const quality = IA.evaluateQuality({
      expectedFollowers: profileInfo?.followerCount,
      expectedFollowing: profileInfo?.followingCount,
      followers,
      following,
      followersMeta: followersResult?.meta,
      followingMeta: followingResult?.meta
    });

    return {
      id: crypto.randomUUID(),
      username: IA.normalizeAccountKey(username),
      userId: String(userId),
      profileInfo: profileInfo || {},
      followers,
      following,
      quality,
      comparisonEligible: !!quality.comparisonEligible,
      createdAt: Date.now()
    };
  }

  function findPreviousEligible(snapshots, currentId) {
    return snapshots.find((snapshot) => snapshot.id !== currentId && snapshot.comparisonEligible === true) || null;
  }

  function attachDiff(snapshot, previous, diff) {
    const compact = IA.compactDiff(diff);
    snapshot.previousEligibleId = previous?.id || null;
    snapshot.differences = compact;
    snapshot.diffSummary = {
      baseline: !!diff.baseline,
      notFollowingBack: diff.notFollowingBack.length,
      unfollows: diff.unfollows.length,
      newFollowers: diff.newFollowers.length,
      youUnfollowed: diff.youUnfollowed.length,
      youStartedFollowing: diff.youStartedFollowing.length
    };
    return snapshot;
  }

  Object.assign(IA, { createSnapshot, findPreviousEligible, attachSnapshotDiff: attachDiff });
})();
