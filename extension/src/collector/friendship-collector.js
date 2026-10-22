window.InstaAnalytics = window.InstaAnalytics || {};
(() => {
  async function collectFriendships(userId, type, onProgress, options = {}) {
    const IA = window.InstaAnalytics;

    const users = [];
    const seen = new Set();

    const rawExpected = Number(options?.expectedCount);
    const expectedCount =
      options?.expectedCount !== null && options?.expectedCount !== undefined && options?.expectedCount !== "" && Number.isFinite(rawExpected) && rawExpected >= 0
        ? rawExpected
        : null;

    let maxId = "";
    let page = 0;
    let stagnantPages = 0;
    let completed = false;
    let stopReason = "unknown";
    let receivedTotal = 0;
    let invalidTotal = 0;
    let duplicateTotal = 0;
    const pageStats = [];

    while (true) {
      page += 1;

      const params = new URLSearchParams({
        count: "100",
        search_surface: "follow_list_page"
      });

      if (maxId) params.set("max_id", maxId);

      const data = await IA.requestJson(
        `https://www.instagram.com/api/v1/friendships/${encodeURIComponent(userId)}/${type}/?${params.toString()}`,
        `${type} página ${page}`
      );

      const before = users.length;
      const received = Array.isArray(data?.users) ? data.users.length : 0;
      receivedTotal += received;

      for (const raw of data?.users || []) {
        const user = IA.normalizeUser(raw);
        if (!user) { invalidTotal++; continue; }

        const key = IA.stableKey(user);
        if (!key) { invalidTotal++; continue; }
        if (seen.has(key)) { duplicateTotal++; continue; }

        seen.add(key);
        users.push(user);
      }

      stagnantPages = users.length === before ? stagnantPages + 1 : 0;
      pageStats.push({ page, received, uniqueAdded: users.length - before, hasNext: Boolean(data?.next_max_id) });

      onProgress?.({
        page,
        collected: users.length,
        expectedCount,
        pageReceived: Array.isArray(data?.users) ? data.users.length : 0
      });

      if (!data?.next_max_id) {
        completed = true;
        stopReason = "end_of_pagination";
        break;
      }

      if (stagnantPages >= 2) {
        completed = false;
        stopReason = "stagnant_pages";
        break;
      }

      maxId = data.next_max_id;
      await IA.sleep(900 + Math.floor(Math.random() * 700));
    }

    return {
      users,
      meta: {
        completed,
        stopReason,
        pages: page,
        receivedTotal, invalidTotal, duplicateTotal, pageStats,
        collected: users.length,
        expectedCount,
        missing:
          expectedCount === null
            ? null
            : Math.max(0, expectedCount - users.length)
      }
    };
  }

  window.InstaAnalytics.collectFriendships = collectFriendships;
})();
