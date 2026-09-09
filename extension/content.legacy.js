(() => {
  if (window.__instaUnfollowPremiumLoaded) return;
  window.__instaUnfollowPremiumLoaded = true;

  const APP_ID = "936619743392459";
  const STORAGE_KEY = "iu_snapshots_v7";
  const MAX_SNAPSHOTS_PER_USER = 5;

  const REQUEST_DELAY_MS = 1100;
  const MAX_RETRIES = 3;
  const MIN_COMPLETENESS_RATIO = 0.985;
  const SUSPICIOUS_MISSING_TOLERANCE = 3;

  const state = {
    activeTab: "not-following-back",
    loading: false,
    username: "",
    current: null,
    previous: null,
    snapshots: [],
    profileInfo: null,
    status: "Pronto.",
    filter: ""
  };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function debug(...args) {
    console.log("[Insta Unfollow Premium]", ...args);
  }

  function getCurrentUsernameFromPage() {
    const path = location.pathname.replace(/^\/+|\/+$/g, "");
    if (path && !["accounts", "explore", "direct", "reels"].includes(path.split("/")[0])) {
      return path.split("/")[0];
    }

    const meta = document.querySelector('meta[property="og:title"]');
    if (meta?.content) {
      const match = meta.content.match(/^@?([a-zA-Z0-9._]+)/);
      if (match) return match[1];
    }

    return "";
  }

  function setStatus(text) {
    state.status = text;
    render();
  }

  function normalizeUser(user) {
    if (!user) return null;

    if (typeof user === "string") {
      return {
        id: "",
        username: user,
        fullName: "",
        profilePic: ""
      };
    }

    return {
      id: String(user.id || user.pk || "").trim(),
      username: String(user.username || "").trim(),
      fullName: String(user.fullName || user.full_name || "").trim(),
      profilePic: String(user.profilePic || user.profile_pic_url || "").trim()
    };
  }

  function getStableUserKey(user) {
    const normalized = normalizeUser(user);
    return (normalized.id || normalized.username).toLowerCase();
  }

  function normalizeUsers(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];

    for (const raw of list) {
      const user = normalizeUser(raw);
      if (!user?.username) continue;

      const key = getStableUserKey(user);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(user);
    }

    return out;
  }

  async function fetchJsonWithRetry(url, options = {}, label = "requisição") {
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, {
          credentials: "include",
          headers: {
            accept: "application/json",
            "x-ig-app-id": APP_ID,
            "x-requested-with": "XMLHttpRequest",
            ...(options.headers || {})
          },
          ...options
        });

        const text = await response.text();
        let data = null;

        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = { raw: text };
        }

        if (!response.ok) {
          const msg = data?.message || data?.error_type || `HTTP ${response.status}`;
          throw new Error(msg);
        }

        return data;
      } catch (error) {
        lastError = error;
        debug(`${label} falhou na tentativa ${attempt}:`, error?.message || error);

        if (attempt < MAX_RETRIES) {
          await sleep(900 * attempt);
        }
      }
    }

    throw new Error(`${label} falhou após ${MAX_RETRIES} tentativas: ${lastError?.message || "erro desconhecido"}`);
  }

  async function resolveUserId(username) {
    const q = encodeURIComponent(username);
    const url = `https://www.instagram.com/web/search/topsearch/?context=blended&query=${q}`;
    const data = await fetchJsonWithRetry(url, {}, "resolver user id");

    const candidates = Array.isArray(data?.users) ? data.users : [];
    const exact = candidates.find(
      (u) => u?.user?.username?.toLowerCase() === username.toLowerCase()
    );

    if (!exact?.user?.pk) {
      throw new Error("Não consegui resolver o user id do perfil.");
    }

    const user = exact.user;

    return {
      userId: String(user.pk),
      profileInfo: {
        username: user.username || username,
        fullName: user.full_name || "",
        profilePic: user.profile_pic_url || "",
        isPrivate: !!user.is_private,
        isVerified: !!user.is_verified,
        followerCount: Number(user.follower_count || 0),
        followingCount: Number(user.following_count || 0)
      }
    };
  }

  async function fetchFriendshipList(userId, type, expectedCount, onProgress) {
    const users = [];
    const seen = new Set();
    let maxId = "";
    let page = 0;
    let stagnantPages = 0;

    while (true) {
      page += 1;

      const params = new URLSearchParams({
        count: "100",
        search_surface: "follow_list_page"
      });

      if (maxId) params.set("max_id", maxId);

      const url = `https://www.instagram.com/api/v1/friendships/${userId}/${type}/?${params.toString()}`;
      const data = await fetchJsonWithRetry(url, {}, `${type} página ${page}`);

      const pageUsers = Array.isArray(data?.users) ? data.users : [];
      const before = users.length;

      for (const u of pageUsers) {
        const normalized = normalizeUser({
          id: String(u?.pk || ""),
          username: String(u?.username || "").trim(),
          fullName: String(u?.full_name || "").trim()
          // profilePic removido daqui para economizar storage
        });

        if (!normalized.username) continue;

        const key = getStableUserKey(normalized);
        if (seen.has(key)) continue;

        seen.add(key);
        users.push(normalized);
      }

      const addedNow = users.length - before;
      if (addedNow === 0) stagnantPages++;
      else stagnantPages = 0;

      if (typeof onProgress === "function") {
        onProgress({
          type,
          page,
          collected: users.length,
          expectedCount
        });
      }

      if (!data?.next_max_id) break;
      if (stagnantPages >= 2) break;

      maxId = data.next_max_id;
      await sleep(REQUEST_DELAY_MS);
    }

    return users;
  }

  function evaluateCollectionQuality(snapshot) {
    const expectedFollowers = Number(snapshot?.profileInfo?.followerCount || 0);
    const expectedFollowing = Number(snapshot?.profileInfo?.followingCount || 0);
    const actualFollowers = normalizeUsers(snapshot?.followers).length;
    const actualFollowing = normalizeUsers(snapshot?.following).length;

    const followersRatio = expectedFollowers > 0 ? actualFollowers / expectedFollowers : 1;
    const followingRatio = expectedFollowing > 0 ? actualFollowing / expectedFollowing : 1;

    const followersMissing = Math.max(0, expectedFollowers - actualFollowers);
    const followingMissing = Math.max(0, expectedFollowing - actualFollowing);

    const suspicious =
      (expectedFollowers > 0 && followersRatio < MIN_COMPLETENESS_RATIO && followersMissing > SUSPICIOUS_MISSING_TOLERANCE) ||
      (expectedFollowing > 0 && followingRatio < MIN_COMPLETENESS_RATIO && followingMissing > SUSPICIOUS_MISSING_TOLERANCE);

    return {
      expectedFollowers,
      expectedFollowing,
      actualFollowers,
      actualFollowing,
      followersRatio,
      followingRatio,
      followersMissing,
      followingMissing,
      suspicious
    };
  }

  function buildSet(list) {
    return new Set(normalizeUsers(list).map(getStableUserKey));
  }

  function diffLists(currentFollowers, currentFollowing, previousFollowers = [], previousFollowing = [], currentSnapshot = null) {
    const followers = normalizeUsers(currentFollowers);
    const following = normalizeUsers(currentFollowing);
    const prevFollowers = normalizeUsers(previousFollowers);
    const prevFollowing = normalizeUsers(previousFollowing);

    const followersSet = buildSet(followers);
    const followingSet = buildSet(following);
    const prevFollowersSet = buildSet(prevFollowers);
    const prevFollowingSet = buildSet(prevFollowing);

    const quality = currentSnapshot ? evaluateCollectionQuality(currentSnapshot) : null;
    const cautiousMode = !!quality?.suspicious;

    const notFollowingBack = following.filter(
      (u) => !followersSet.has(getStableUserKey(u))
    );

    const unfollows = cautiousMode
      ? []
      : prevFollowers.filter((u) => !followersSet.has(getStableUserKey(u)));

    const newFollowers = cautiousMode
      ? []
      : followers.filter((u) => !prevFollowersSet.has(getStableUserKey(u)));

    const youUnfollowed = cautiousMode
      ? []
      : prevFollowing.filter((u) => !followingSet.has(getStableUserKey(u)));

    const youStartedFollowing = cautiousMode
      ? []
      : following.filter((u) => !prevFollowingSet.has(getStableUserKey(u)));

    return {
      followers,
      following,
      notFollowingBack,
      unfollows,
      newFollowers,
      youUnfollowed,
      youStartedFollowing,
      quality,
      cautiousMode
    };
  }

  function getSnapshotsForUser(all, username) {
    return (all[username] || []).sort((a, b) => b.createdAt - a.createdAt);
  }

  async function loadSnapshots(username) {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const all = data[STORAGE_KEY] || {};
    return getSnapshotsForUser(all, username);
  }

  function compactSnapshot(snapshot) {
    return {
      username: snapshot.username,
      userId: snapshot.userId,
      createdAt: snapshot.createdAt,
      profileInfo: {
        username: snapshot.profileInfo?.username || "",
        fullName: snapshot.profileInfo?.fullName || "",
        profilePic: snapshot.profileInfo?.profilePic || "",
        isPrivate: !!snapshot.profileInfo?.isPrivate,
        isVerified: !!snapshot.profileInfo?.isVerified,
        followerCount: Number(snapshot.profileInfo?.followerCount || 0),
        followingCount: Number(snapshot.profileInfo?.followingCount || 0)
      },
      followers: normalizeUsers(snapshot.followers).map((u) => ({
        id: u.id || "",
        username: u.username || "",
        fullName: u.fullName || ""
      })),
      following: normalizeUsers(snapshot.following).map((u) => ({
        id: u.id || "",
        username: u.username || "",
        fullName: u.fullName || ""
      }))
    };
  }

  async function saveSnapshot(username, snapshot) {
    const compacted = compactSnapshot(snapshot);

    const data = await chrome.storage.local.get(STORAGE_KEY);
    const all = data[STORAGE_KEY] || {};
    const current = getSnapshotsForUser(all, username);

    current.unshift(compacted);
    all[username] = current.slice(0, MAX_SNAPSHOTS_PER_USER);

    await chrome.storage.local.set({ [STORAGE_KEY]: all });
    return all[username];
  }

  async function cleanupLegacyStorage() {
    const legacyKeys = [
      "history",
      "iu_snapshots_v1",
      "iu_snapshots_v2",
      "iu_snapshots_v3",
      "iu_snapshots_v4",
      "iu_snapshots_v5",
      "iu_snapshots_v6"
    ];

    await chrome.storage.local.remove(legacyKeys);
  }

  async function clearSnapshots(username) {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const all = data[STORAGE_KEY] || {};
    delete all[username];
    await chrome.storage.local.set({ [STORAGE_KEY]: all });
  }

  function formatDate(ts) {
    return new Date(ts).toLocaleString("pt-BR");
  }

  function getUsernameInput() {
    const input = root.querySelector("#iu-username");
    const value = input.value.trim().replace(/^@/, "");
    state.username = value;
    return value;
  }

  function filterUsers(list) {
    const q = state.filter.trim().toLowerCase();
    if (!q) return list;

    return list.filter((u) => {
      const username = String(u.username || "").toLowerCase();
      const fullName = String(u.fullName || "").toLowerCase();
      return username.includes(q) || fullName.includes(q);
    });
  }

  function getComputedData() {
    if (!state.current) {
      return {
        followers: [],
        following: [],
        notFollowingBack: [],
        unfollows: [],
        newFollowers: [],
        youUnfollowed: [],
        youStartedFollowing: [],
        history: state.snapshots,
        quality: null,
        cautiousMode: false
      };
    }

    const previous = state.previous || { followers: [], following: [] };

    return {
      ...diffLists(
        state.current.followers,
        state.current.following,
        previous.followers,
        previous.following,
        state.current
      ),
      history: state.snapshots
    };
  }

  function getPageMeta(tab, data) {
    const map = {
      "not-following-back": {
        title: "Não seguem de volta",
        subtitle: `${data.notFollowingBack.length} perfis encontrados`
      },
      "unfollows": {
        title: "Unfollows",
        subtitle: `${data.unfollows.length} perfis deixaram de seguir desde a última coleta`
      },
      "new-followers": {
        title: "Novos seguidores",
        subtitle: `${data.newFollowers.length} novos perfis encontrados`
      },
      "you-unfollowed": {
        title: "Você deixou de seguir",
        subtitle: `${data.youUnfollowed.length} perfis não aparecem mais em seguindo`
      },
      "you-started-following": {
        title: "Você começou a seguir",
        subtitle: `${data.youStartedFollowing.length} novos perfis em seguindo`
      },
      "history": {
        title: "Histórico",
        subtitle: `${data.history.length} snapshots salvos para este perfil`
      }
    };

    return map[tab] || { title: "Lista", subtitle: "" };
  }

  function buildUI() {
    const root = document.createElement("div");
    root.id = "iu-root";

    root.innerHTML = `
      <div id="iu-panel">
        <div class="iu-header">
          <div class="iu-title-wrap">
            <div class="iu-title">Insta Unfollow Premium</div>
            <div class="iu-subtitle">Painel lateral profissional com histórico e comparação</div>
          </div>
          <button class="iu-close" id="iu-close-btn">×</button>
        </div>

        <div class="iu-body">
          <aside class="iu-sidebar">
            <div class="iu-profile-card">
              <img id="iu-profile-avatar" class="iu-profile-avatar" src="" alt="">
              <div class="iu-profile-main">
                <div id="iu-profile-username" class="iu-profile-username">Nenhum perfil carregado</div>
                <div id="iu-profile-fullname" class="iu-profile-fullname"></div>
                <div id="iu-profile-meta" class="iu-profile-meta"></div>
              </div>
            </div>

            <div class="iu-row">
              <input id="iu-username" class="iu-input" placeholder="Usuário do Instagram">
              <button id="iu-load-btn" class="iu-btn">Carregar</button>
            </div>

            <div class="iu-toolbar">
              <button id="iu-use-current-btn" class="iu-btn iu-btn-light">Usar perfil atual</button>
              <button id="iu-clear-btn" class="iu-btn iu-btn-light">Limpar histórico</button>
              <button id="iu-export-btn" class="iu-btn iu-btn-light">Exportar JSON</button>
            </div>

            <div id="iu-status" class="iu-status"></div>

            <div class="iu-stats">
              <div class="iu-stat">
                <span class="iu-stat-label">Seguidores</span>
                <span class="iu-stat-value" id="iu-stat-followers">-</span>
              </div>
              <div class="iu-stat">
                <span class="iu-stat-label">Seguindo</span>
                <span class="iu-stat-value" id="iu-stat-following">-</span>
              </div>
              <div class="iu-stat">
                <span class="iu-stat-label">Não seguem de volta</span>
                <span class="iu-stat-value" id="iu-stat-nfb">-</span>
              </div>
              <div class="iu-stat">
                <span class="iu-stat-label">Unfollows</span>
                <span class="iu-stat-value" id="iu-stat-unfollows">-</span>
              </div>
            </div>

            <nav class="iu-tabs">
              <button class="iu-tab active" data-tab="not-following-back">Não seguem de volta</button>
              <button class="iu-tab" data-tab="unfollows">Unfollows</button>
              <button class="iu-tab" data-tab="new-followers">Novos seguidores</button>
              <button class="iu-tab" data-tab="you-unfollowed">Você deixou de seguir</button>
              <button class="iu-tab" data-tab="you-started-following">Você começou a seguir</button>
              <button class="iu-tab" data-tab="history">Histórico</button>
            </nav>
          </aside>

          <main class="iu-main">
            <div class="iu-page">
              <div class="iu-page-header">
                <div id="iu-page-title" class="iu-page-title">Não seguem de volta</div>
                <div id="iu-page-subtitle" class="iu-page-subtitle"></div>
                <div class="iu-list-tools">
                  <input id="iu-filter" class="iu-input" placeholder="Buscar por usuário ou nome">
                </div>
                <div id="iu-page-warning"></div>
              </div>

              <div id="iu-list" class="iu-list"></div>
            </div>

            <div class="iu-small" id="iu-footnote"></div>
          </main>
        </div>
      </div>
    `;

    document.documentElement.appendChild(root);

    root.querySelector("#iu-close-btn").addEventListener("click", togglePanel);

    root.querySelector("#iu-use-current-btn").addEventListener("click", async () => {
      const username = getCurrentUsernameFromPage();
      const input = root.querySelector("#iu-username");
      input.value = username;
      state.username = username;
      state.snapshots = await loadSnapshots(username);
      state.current = state.snapshots[0] || null;
      state.previous = state.snapshots[1] || null;
      state.profileInfo = state.current?.profileInfo || null;
      setStatus(username ? `Perfil atual selecionado: @${username}` : "Não consegui detectar o perfil atual.");
    });

    root.querySelector("#iu-load-btn").addEventListener("click", runCollection);

    root.querySelector("#iu-clear-btn").addEventListener("click", async () => {
      const username = getUsernameInput();
      if (!username) return alert("Informe um usuário primeiro.");

      const ok = confirm(`Apagar histórico salvo de @${username}?`);
      if (!ok) return;

      await clearSnapshots(username);
      state.snapshots = [];
      state.current = null;
      state.previous = null;
      state.profileInfo = null;
      setStatus(`Histórico de @${username} apagado.`);
    });

    root.querySelector("#iu-export-btn").addEventListener("click", async () => {
      const username = getUsernameInput();
      if (!username) {
        alert("Informe um usuário primeiro.");
        return;
      }

      const snapshots = await loadSnapshots(username);

      if (!snapshots.length) {
        alert("Não há histórico salvo para exportar.");
        return;
      }

      const exportData = {
        username,
        exportedAt: new Date().toISOString(),
        totalSnapshots: snapshots.length,
        snapshots: snapshots.map((snapshot) => ({
          username: snapshot.username,
          userId: snapshot.userId || "",
          createdAt: snapshot.createdAt,
          profileInfo: snapshot.profileInfo || {},
          followers: normalizeUsers(snapshot.followers),
          following: normalizeUsers(snapshot.following)
        }))
      };

      const blob = new Blob(
        [JSON.stringify(exportData, null, 2)],
        { type: "application/json" }
      );

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `insta-unfollow-completo-${username}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    root.querySelectorAll(".iu-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.activeTab = btn.dataset.tab;
        state.filter = "";
        render();
      });
    });

    root.querySelector("#iu-filter").addEventListener("input", (e) => {
      state.filter = e.target.value || "";
      render();
    });

    return root;
  }

  const root = buildUI();
  const panel = root.querySelector("#iu-panel");

  function togglePanel() {
    panel.classList.toggle("iu-open");

    if (panel.classList.contains("iu-open")) {
      const current = getCurrentUsernameFromPage();
      const input = root.querySelector("#iu-username");

      if (!input.value && current) input.value = current;
      if (!state.username && current) state.username = current;

      render();
    }
  }

  function renderProfileInfo() {
    const avatar = root.querySelector("#iu-profile-avatar");
    const username = root.querySelector("#iu-profile-username");
    const fullName = root.querySelector("#iu-profile-fullname");
    const meta = root.querySelector("#iu-profile-meta");

    const info = state.profileInfo || state.current?.profileInfo || null;

    if (!info) {
      avatar.src = "";
      avatar.style.visibility = "hidden";
      username.textContent = "Nenhum perfil carregado";
      fullName.textContent = "";
      meta.innerHTML = "";
      return;
    }

    avatar.style.visibility = "visible";
    avatar.src = info.profilePic || "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
    username.textContent = `@${info.username || ""}`;
    fullName.textContent = info.fullName || "";
    meta.innerHTML = `
      ${info.isPrivate ? "<span>Privado</span>" : "<span>Público</span>"}
      ${info.isVerified ? "<span>Verificado</span>" : ""}
      ${state.current ? `<span>Última coleta: ${formatDate(state.current.createdAt)}</span>` : ""}
    `;
  }

  function renderUserList(list) {
    if (!list.length) {
      return `<div class="iu-empty">Nada para mostrar.</div>`;
    }

    return list.map((item) => {
      const username = escapeHtml(item.username || "");
      const fullName = escapeHtml(item.fullName || "");
      const profilePic = escapeHtml(item.profilePic || "data:image/gif;base64,R0lGODlhAQABAAAAACw=");
      const profileUrl = `https://www.instagram.com/${username}/`;

      return `
        <div class="iu-item">
          <img class="iu-item-avatar" src="${profilePic}" alt="${username}">
          <div class="iu-item-main">
            <a class="iu-item-username" href="${profileUrl}" target="_blank" rel="noreferrer">@${username}</a>
            <span class="iu-item-fullname">${fullName}</span>
          </div>
          <div class="iu-item-action">
            <a class="iu-open-link" href="${profileUrl}" target="_blank" rel="noreferrer">Abrir</a>
          </div>
        </div>
      `;
    }).join("");
  }

  function renderHistoryItems(history) {
    if (!history.length) {
      return `<div class="iu-empty">Sem coletas salvas.</div>`;
    }

    return history.map((snapshot, index) => {
      const tag = index === 0 ? "Atual" : index === 1 ? "Anterior" : `#${history.length - index}`;
      const info = snapshot.profileInfo || {};
      const avatar = escapeHtml(info.profilePic || "data:image/gif;base64,R0lGODlhAQABAAAAACw=");
      const username = escapeHtml(snapshot.username || info.username || "");
      const fullName = escapeHtml(info.fullName || "");
      const quality = evaluateCollectionQuality(snapshot);

      return `
        <div class="iu-item">
          <img class="iu-item-avatar" src="${avatar}" alt="${username}">
          <div class="iu-item-main">
            <div class="iu-history-block">
              <span class="iu-badge">${tag}</span>
              <a class="iu-item-username" href="https://www.instagram.com/${username}/" target="_blank" rel="noreferrer">@${username}</a>
              <span class="iu-item-fullname">${fullName}</span>
              <span class="iu-item-fullname">${formatDate(snapshot.createdAt)}</span>
              <span class="iu-item-fullname">Seguidores: ${normalizeUsers(snapshot.followers).length} | Seguindo: ${normalizeUsers(snapshot.following).length}</span>
              ${quality.suspicious ? `<span class="iu-item-fullname">Coleta possivelmente incompleta</span>` : ""}
            </div>
          </div>
        </div>
      `;
    }).join("");
  }

  function renderWarning(data) {
    if (!data.cautiousMode || !data.quality) return "";

    return `
      <div class="iu-warning">
        Modo cauteloso ativado. A coleta pode estar incompleta:
        seguindo ${data.quality.actualFollowing}/${data.quality.expectedFollowing}.
        Comparações finas foram suavizadas para evitar falso positivo.
      </div>
    `;
  }

  function render() {
    const input = root.querySelector("#iu-username");
    if (state.username && input.value !== state.username) {
      input.value = state.username;
    }

    root.querySelector("#iu-status").textContent = state.status;
    root.querySelector("#iu-load-btn").disabled = state.loading;
    root.querySelector("#iu-load-btn").textContent = state.loading ? "Coletando..." : "Carregar";
    root.querySelector("#iu-filter").value = state.filter;

    renderProfileInfo();

    const data = getComputedData();

    root.querySelector("#iu-stat-followers").textContent = data.followers.length || "-";
    root.querySelector("#iu-stat-following").textContent = data.following.length || "-";
    root.querySelector("#iu-stat-nfb").textContent = data.notFollowingBack.length || "-";
    root.querySelector("#iu-stat-unfollows").textContent = data.unfollows.length || "-";

    root.querySelectorAll(".iu-tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.tab === state.activeTab);
    });

    const pageMeta = getPageMeta(state.activeTab, data);
    root.querySelector("#iu-page-title").textContent = pageMeta.title;
    root.querySelector("#iu-page-subtitle").textContent = pageMeta.subtitle;
    root.querySelector("#iu-page-warning").innerHTML = renderWarning(data);

    const list = root.querySelector("#iu-list");

    if (state.activeTab === "not-following-back") {
      list.innerHTML = renderUserList(filterUsers(data.notFollowingBack));
    } else if (state.activeTab === "unfollows") {
      list.innerHTML = renderUserList(filterUsers(data.unfollows));
    } else if (state.activeTab === "new-followers") {
      list.innerHTML = renderUserList(filterUsers(data.newFollowers));
    } else if (state.activeTab === "you-unfollowed") {
      list.innerHTML = renderUserList(filterUsers(data.youUnfollowed));
    } else if (state.activeTab === "you-started-following") {
      list.innerHTML = renderUserList(filterUsers(data.youStartedFollowing));
    } else if (state.activeTab === "history") {
      list.innerHTML = renderHistoryItems(data.history);
    }

    let footnote = state.current
      ? `Última coleta de @${state.current.username} em ${formatDate(state.current.createdAt)}`
      : "Clique no ícone da extensão para abrir/fechar o painel.";

    root.querySelector("#iu-footnote").textContent = footnote;
  }

  async function runCollection() {
    const username = getUsernameInput();

    if (!username) {
      alert("Informe o usuário ou clique em 'Usar perfil atual'.");
      return;
    }

    state.loading = true;
    render();

    try {
      setStatus(`Resolvendo ID de @${username}...`);
      const resolved = await resolveUserId(username);
      const userId = resolved.userId;
      const profileInfo = resolved.profileInfo;

      state.profileInfo = profileInfo;
      render();

      setStatus(`Coletando seguidores de @${username}...`);
      const followers = await fetchFriendshipList(
        userId,
        "followers",
        profileInfo.followerCount,
        ({ collected, expectedCount }) => {
          setStatus(`Coletando seguidores de @${username}...\nColetados: ${collected}${expectedCount ? ` / esperado: ${expectedCount}` : ""}`);
        }
      );

      setStatus(`Coletando seguindo de @${username}...`);
      const following = await fetchFriendshipList(
        userId,
        "following",
        profileInfo.followingCount,
        ({ collected, expectedCount }) => {
          setStatus(`Coletando seguindo de @${username}...\nColetados: ${collected}${expectedCount ? ` / esperado: ${expectedCount}` : ""}`);
        }
      );

      const snapshot = {
        username,
        userId,
        followers: normalizeUsers(followers),
        following: normalizeUsers(following),
        profileInfo,
        createdAt: Date.now()
      };

      const quality = evaluateCollectionQuality(snapshot);
      const saved = await saveSnapshot(username, snapshot);

      state.snapshots = saved;
      state.current = saved[0] || snapshot;
      state.previous = saved[1] || null;
      state.profileInfo = state.current.profileInfo || profileInfo;

      const diffs = diffLists(
        state.current.followers,
        state.current.following,
        state.previous?.followers || [],
        state.previous?.following || [],
        state.current
      );

      let msg =
        `Coleta concluída.\n` +
        `Seguidores: ${state.current.followers.length}\n` +
        `Seguindo: ${state.current.following.length}\n` +
        `Não seguem de volta: ${diffs.notFollowingBack.length}\n`;

      if (diffs.cautiousMode) {
        msg += `Comparações finas pausadas: coleta possivelmente incompleta.\n`;
      } else {
        msg +=
          `Unfollows desde a última coleta: ${diffs.unfollows.length}\n` +
          `Novos seguidores: ${diffs.newFollowers.length}\n`;
      }

      if (quality.suspicious) {
        msg +=
          `\nAviso: a coleta ficou abaixo do esperado.\n` +
          `Seguidores coletados: ${quality.actualFollowers}/${quality.expectedFollowers}\n` +
          `Seguindo coletados: ${quality.actualFollowing}/${quality.expectedFollowing}`;
      }

      setStatus(msg);
    } catch (err) {
      debug("Erro ao coletar:", err);
      setStatus(`Erro: ${err.message}`);
      alert(`Erro ao coletar: ${err.message}`);
    } finally {
      state.loading = false;
      render();
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "toggle-panel") {
      togglePanel();
    }
  });

  async function bootstrap() {
    try {
      await cleanupLegacyStorage();
    } catch (error) {
      debug("Erro ao limpar storage legado:", error);
    }

    state.username = getCurrentUsernameFromPage();
    render();
  }

  bootstrap();
})();