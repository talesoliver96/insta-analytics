window.InstaAnalytics = window.InstaAnalytics || {};
(() => {
  const IA = window.InstaAnalytics;

  function numberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  async function resolveProfile(username) {
    const normalized = IA.normalizeAccountKey(username);
    const q = encodeURIComponent(normalized);
    const search = await IA.requestJson(
      `https://www.instagram.com/web/search/topsearch/?context=blended&query=${q}`,
      "resolver perfil"
    );

    const exact = (search?.users || []).find(
      (item) => item?.user?.username?.toLowerCase() === normalized
    )?.user;

    if (!exact?.pk) throw new Error("Não consegui localizar esse perfil.");

    const profileInfo = {
      username: exact.username || normalized,
      fullName: exact.full_name || "",
      profilePic: exact.profile_pic_url || "",
      isPrivate: !!exact.is_private,
      isVerified: !!exact.is_verified,
      followerCount: numberOrNull(exact.follower_count),
      followingCount: numberOrNull(exact.following_count)
    };

    try {
      const extra = await IA.requestJson(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${q}`,
        "carregar detalhes do perfil"
      );
      const user = extra?.data?.user || extra?.user || null;
      if (user) {
        profileInfo.fullName = user.full_name || profileInfo.fullName;
        profileInfo.profilePic = user.profile_pic_url_hd || user.profile_pic_url || profileInfo.profilePic;
        profileInfo.isPrivate = !!user.is_private;
        profileInfo.isVerified = !!user.is_verified;
        profileInfo.followerCount = numberOrNull(user.edge_followed_by?.count ?? user.follower_count) ?? profileInfo.followerCount;
        profileInfo.followingCount = numberOrNull(user.edge_follow?.count ?? user.following_count) ?? profileInfo.followingCount;
      }
    } catch {
      // O endpoint complementar é apenas um enriquecimento; a coleta continua sem ele.
    }

    return { userId: String(exact.pk), profileInfo };
  }

  window.InstaAnalytics.resolveProfile = resolveProfile;
})();
