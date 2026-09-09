window.InstaAnalytics = window.InstaAnalytics || {};
(() => {
  const normalizeAccountKey = (username = "") => String(username).trim().replace(/^@/, "").toLowerCase();

  const normalizeUser = (raw) => {
    if (!raw) return null;
    if (typeof raw === "string") raw = { username: raw };

    const user = {
      id: String(raw.id || raw.pk || "").trim(),
      username: String(raw.username || "").trim(),
      fullName: String(raw.fullName || raw.full_name || "").trim(),
      profilePic: String(raw.profilePic || raw.profile_pic_url || "").trim()
    };

    return user.username ? user : null;
  };

  const stableKey = (raw) => {
    const u = normalizeUser(raw);
    return u ? String(u.id || u.username).toLowerCase() : "";
  };

  const normalizeUsers = (list = []) => {
    const seen = new Set();
    return (Array.isArray(list) ? list : []).reduce((out, raw) => {
      const user = normalizeUser(raw);
      if (!user) return out;

      const key = stableKey(user);
      if (!key || seen.has(key)) return out;

      seen.add(key);
      out.push(user);
      return out;
    }, []);
  };

  Object.assign(window.InstaAnalytics, {
    normalizeAccountKey,
    normalizeUser,
    normalizeUsers,
    stableKey
  });
})();
