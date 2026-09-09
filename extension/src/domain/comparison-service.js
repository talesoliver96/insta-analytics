window.InstaAnalytics = window.InstaAnalytics || {};
(() => {
  const IA = window.InstaAnalytics;

  function compare(current, previous) {
    const followers = IA.normalizeUsers(current?.followers);
    const following = IA.normalizeUsers(current?.following);
    const followerSet = new Set(followers.map(IA.stableKey));
    const followingSet = new Set(following.map(IA.stableKey));
    const notFollowingBack = following.filter((u) => !followerSet.has(IA.stableKey(u)));

    if (!previous) {
      return {
        baseline: true,
        followers,
        following,
        notFollowingBack,
        unfollows: [],
        newFollowers: [],
        youUnfollowed: [],
        youStartedFollowing: []
      };
    }

    const previousFollowers = IA.normalizeUsers(previous.followers);
    const previousFollowing = IA.normalizeUsers(previous.following);
    const previousFollowersSet = new Set(previousFollowers.map(IA.stableKey));
    const previousFollowingSet = new Set(previousFollowing.map(IA.stableKey));

    return {
      baseline: false,
      followers,
      following,
      notFollowingBack,
      unfollows: previousFollowers.filter((u) => !followerSet.has(IA.stableKey(u))),
      newFollowers: followers.filter((u) => !previousFollowersSet.has(IA.stableKey(u))),
      youUnfollowed: previousFollowing.filter((u) => !followingSet.has(IA.stableKey(u))),
      youStartedFollowing: following.filter((u) => !previousFollowingSet.has(IA.stableKey(u)))
    };
  }

  function compactDiff(diff) {
    return {
      baseline: !!diff.baseline,
      notFollowingBack: IA.normalizeUsers(diff.notFollowingBack),
      unfollows: IA.normalizeUsers(diff.unfollows),
      newFollowers: IA.normalizeUsers(diff.newFollowers),
      youUnfollowed: IA.normalizeUsers(diff.youUnfollowed),
      youStartedFollowing: IA.normalizeUsers(diff.youStartedFollowing)
    };
  }

  Object.assign(IA, { compareSnapshots: compare, compactDiff });
})();
