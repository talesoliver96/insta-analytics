window.InstaAnalytics = window.InstaAnalytics || {};
(() => {
  const IA = window.InstaAnalytics;
  const numberOrNull = (value) => value == null || value === "" ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
  async function resolveProfile(username) {
    const normalized = IA.normalizeAccountKey(username);
    if (!normalized) throw new Error("Usuário do Instagram não identificado.");
    const data = await IA.requestJson(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(normalized)}`,
      "consultar perfil"
    );
    const user = data?.data?.user || data?.user;
    const pk = user?.id || user?.pk || user?.pk_id;
    if (!user || !pk || IA.normalizeAccountKey(user.username || "") !== normalized) {
      throw new Error("Não foi possível validar o perfil. Seus dados anteriores foram preservados.");
    }
    return {
      userId: String(pk),
      profileInfo: {
        username: normalized,
        fullName: user.full_name || "",
        profilePic: user.profile_pic_url_hd || user.profile_pic_url || "",
        isPrivate: !!user.is_private,
        isVerified: !!user.is_verified,
        followerCount: numberOrNull(user.edge_followed_by?.count ?? user.follower_count),
        followingCount: numberOrNull(user.edge_follow?.count ?? user.following_count)
      }
    };
  }
  IA.resolveProfile = resolveProfile;
})();
