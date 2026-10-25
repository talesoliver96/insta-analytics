window.InstaAnalytics = window.InstaAnalytics || {};
(() => {
  const IA = window.InstaAnalytics;
  let root = null;
  let currentSnapshot = null;
  let currentHistory = [];
  let currentPage = "overview";
  let historyDetailId = null;
  let historyDetailFilter = "all";
  let filterText = "";
  let detectedInstagramAccount = null;

  const pages = [
    ["overview", "Visão geral"],
    ["followers", "Seguidores"],
    ["following", "Seguindo"],
    ["notFollowingBack", "Não seguem de volta"],
    ["unfollows", "Todos os unfollows"],
    ["followedUnfollows", "Unfollows de quem sigo"],
    ["newFollowers", "Novos seguidores"],
    ["youUnfollowed", "Você deixou de seguir"],
    ["youStartedFollowing", "Você começou a seguir"],
    ["history", "Histórico de coletas"]
  ];

  const escapeHtml = (value = "") => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  const formatDate = (value) => new Date(value).toLocaleString("pt-BR");

  function ensurePanel() {
    if (root) return root;

    root = document.createElement("div");
    root.id = "ia-root";
    root.innerHTML = `
      <aside id="ia-panel">
        <header class="ia-topbar">
          <div>
            <strong>Insta Analytics</strong>
            <small>Professional</small>
          </div>
          <button id="ia-close" class="ia-icon-button" aria-label="Fechar">×</button>
        </header>

        <div class="ia-shell">
          <aside class="ia-sidebar">
            <section id="ia-profile" class="ia-profile-card">
              <div class="ia-avatar-placeholder"></div>
              <div>
                <strong>Nenhum perfil carregado</strong>
                <small>Faça uma coleta para começar</small>
              </div>
            </section>

            <nav class="ia-menu">
              ${pages.map(([id, label]) => `<button class="ia-menu-item${id === "overview" ? " active" : ""}" data-page="${id}">${label}</button>`).join("")}
            </nav>

            <section id="ia-auth-box" class="ia-auth-box"></section>
          </aside>

          <main class="ia-main">
            <div class="ia-collect-row ia-detected-row">
              <div id="ia-detected-account" class="ia-detected-account">
                <div class="ia-user-avatar">?</div>
                <div><strong>Detectando sua conta...</strong><span>Somente a conta logada no Instagram pode ser coletada.</span></div>
              </div>
              <button id="ia-refresh-instagram" class="ia-secondary-action">Atualizar usuário</button>
              <button id="ia-collect" class="ia-primary">Coletar</button>
            </div>

            <div id="ia-status" class="ia-status">Pronto.</div>
            <div class="ia-reliability-notice" role="note" aria-label="Aviso sobre precisão das consultas">
              <strong>Aviso sobre precisão</strong>
              <span>O Instagram pode retornar pequenas variações temporárias entre consultas. Um follow ou unfollow isolado pode ser corrigido na coleta seguinte. O Insta Analytics confirma mudanças sensíveis em coletas consecutivas; antes de concluir que houve uma alteração real, confira uma nova coleta.</span>
            </div>
            <div id="ia-progress" class="ia-progress-wrap" hidden></div>
            <div id="ia-content"></div>
          </main>
        </div>
      </aside>
    `;

    document.documentElement.appendChild(root);
    root.querySelector("#ia-close").onclick = toggle;

    root.querySelectorAll(".ia-menu-item").forEach((button) => {
      button.addEventListener("click", () => navigate(button.dataset.page));
    });

    renderAuth();
    return root;
  }

  function toggle() {
    ensurePanel().querySelector("#ia-panel").classList.toggle("open");
  }

  function setStatus(text, type = "default") {
    const node = ensurePanel().querySelector("#ia-status");
    node.textContent = text;
    node.dataset.type = type;
  }

  function setCollecting(loading) {
    const button = ensurePanel().querySelector("#ia-collect");
    const pending = pendingSummary(currentSnapshot);
    button.disabled = loading;
    button.textContent = loading
      ? (pending.total > 0 ? "Confirmando..." : "Coletando...")
      : "Coletar";
  }

  function setProgress(progress) {
    const node = ensurePanel().querySelector("#ia-progress");
    if (!progress) {
      node.hidden = true;
      node.innerHTML = "";
      return;
    }

    const collected = Math.max(0, Number(progress.collected || 0));
    const expected = Number(progress.expected);
    const hasExpected = Number.isFinite(expected) && expected > 0;
    const percent = hasExpected ? Math.min(100, Math.round((collected / expected) * 100)) : null;

    node.hidden = false;
    node.innerHTML = `
      <div class="ia-progress-head">
        <strong>${escapeHtml(progress.label || "Coletando")}</strong>
        <span>${collected.toLocaleString("pt-BR")}${hasExpected ? ` / ${expected.toLocaleString("pt-BR")} · ${percent}%` : ""}</span>
      </div>
      <div class="ia-progress-track">
        <div class="ia-progress-bar${hasExpected ? "" : " indeterminate"}" ${hasExpected ? `style="width:${percent}%"` : ""}></div>
      </div>
    `;
  }

  function renderProfile(snapshot) {
    const profile = root.querySelector("#ia-profile");
    if (!snapshot) {
      profile.innerHTML = `<div class="ia-avatar-placeholder"></div><div><strong>Nenhum perfil carregado</strong><small>Faça uma coleta para começar</small></div>`;
      return;
    }

    const info = snapshot.profileInfo || {};
    const avatar = info.profilePic
      ? `<img class="ia-profile-avatar" src="${escapeHtml(info.profilePic)}" alt="@${escapeHtml(snapshot.username)}">`
      : `<div class="ia-avatar-placeholder">${escapeHtml(snapshot.username?.[0]?.toUpperCase() || "I")}</div>`;

    profile.innerHTML = `
      ${avatar}
      <div class="ia-profile-copy">
        <strong>@${escapeHtml(snapshot.username)}</strong>
        <small>${escapeHtml(info.fullName || "")}</small>
        <span>${info.isPrivate ? "Privado" : "Público"}${info.isVerified ? " · Verificado" : ""}</span>
        <span>${Number(snapshot.followers?.length || 0).toLocaleString("pt-BR")} seguidores · ${Number(snapshot.following?.length || 0).toLocaleString("pt-BR")} seguindo</span>
      </div>
    `;
  }

  function qualityBadge(snapshot) {
    const status = snapshot?.quality?.status || "unknown";
    const map = {
      valid: ["Válida", "good"],
      unverified: ["Válida sem contador", "neutral"],
      suspicious: ["Suspeita", "warning"],
      unknown: ["Desconhecida", "warning"]
    };
    const [label, type] = map[status] || [status, "neutral"];
    return `<span class="ia-badge ${type}">${escapeHtml(label)}</span>`;
  }

  function getDiff(snapshot) {
    return snapshot?.differences || {
      notFollowingBack: [],
      unfollows: [],
      newFollowers: [],
      youUnfollowed: [],
      youStartedFollowing: []
    };
  }

  function getPendingDiff(snapshot) {
    return snapshot?.pendingDifferences || {
      notFollowingBack: [],
      unfollows: [],
      newFollowers: [],
      youUnfollowed: [],
      youStartedFollowing: []
    };
  }

  function pendingSummary(snapshot = currentSnapshot) {
    const summary = snapshot?.diffSummary || {};
    const byType = {
      newFollowers: Number(summary.pendingNewFollowers || 0),
      unfollows: Number(summary.pendingUnfollows || 0),
      youStartedFollowing: Number(summary.pendingYouStartedFollowing || 0),
      youUnfollowed: Number(summary.pendingYouUnfollowed || 0)
    };

    return {
      ...byType,
      total:
        byType.newFollowers +
        byType.unfollows +
        byType.youStartedFollowing +
        byType.youUnfollowed
    };
  }

  // Subconjunto dos unfollows: somente contas que você ainda segue.
  // Não consulta os seguidores de terceiros; usa apenas seus snapshots.
  function onlyAccountsIFollow(users, snapshot = currentSnapshot) {
    const following = snapshot?.following || [];
    const ids = new Set(following.map((u) => String(u?.id || u?.pk || "")).filter(Boolean));
    const names = new Set(following.map((u) => String(u?.username || "").toLowerCase()).filter(Boolean));
    return (users || []).filter((u) =>
      (u?.id && ids.has(String(u.id))) || names.has(String(u?.username || "").toLowerCase())
    );
  }

  function pendingListForPage(page, snapshot = currentSnapshot) {
    const pending = getPendingDiff(snapshot);
    const map = {
      unfollows: pending.unfollows || [],
      followedUnfollows: onlyAccountsIFollow(pending.unfollows, snapshot),
      newFollowers: pending.newFollowers || [],
      youUnfollowed: pending.youUnfollowed || [],
      youStartedFollowing: pending.youStartedFollowing || []
    };
    return map[page] || [];
  }

  function isConfirmationPage(page) {
    return [
      "unfollows",
      "followedUnfollows",
      "newFollowers",
      "youUnfollowed",
      "youStartedFollowing"
    ].includes(page);
  }

  function pendingTypeLabel(page, count = 1) {
    const plural = Number(count) !== 1;
    const map = {
      newFollowers: plural ? "possíveis novos seguidores" : "possível novo seguidor",
      unfollows: plural ? "possíveis unfollows" : "possível unfollow",
      followedUnfollows: plural ? "possíveis unfollows de quem você segue" : "possível unfollow de quem você segue",
      youStartedFollowing: plural ? "possíveis perfis que você começou a seguir" : "possível perfil que você começou a seguir",
      youUnfollowed: plural ? "possíveis perfis que você deixou de seguir" : "possível perfil que você deixou de seguir"
    };
    return map[page] || (plural ? "mudanças pendentes" : "mudança pendente");
  }

  function confirmationBanner(snapshot = currentSnapshot, compact = false) {
    const pending = pendingSummary(snapshot);
    if (!pending.total) return "";

    return `
      <section class="ia-confirmation-banner${compact ? " compact" : ""}">
        <div class="ia-confirmation-icon">✓?</div>
        <div class="ia-confirmation-copy">
          <strong>${pending.total.toLocaleString("pt-BR")} mudança(s) aguardando confirmação</strong>
          <span>A confirmação é automática. Faça <b>mais uma coleta válida</b>; se as mesmas mudanças aparecerem novamente, elas serão confirmadas. Se não aparecerem, o app as descarta para evitar falso positivo.</span>
        </div>
        <button class="ia-confirm-now" data-confirm-collect>Confirmar com nova coleta</button>
      </section>
    `;
  }

  function bindConfirmationButtons(scope = root) {
    scope?.querySelectorAll?.("[data-confirm-collect]").forEach((button) => {
      button.onclick = () => {
        const collect = root.querySelector("#ia-collect");
        if (collect && !collect.disabled) collect.click();
      };
    });
  }

  function statCard(value, label, page) {
    return `<button class="ia-stat-card" data-goto="${page}"><b>${Number(value || 0).toLocaleString("pt-BR")}</b><span>${label}</span></button>`;
  }

  function renderOverview() {
    if (!currentSnapshot) return emptyState("Faça uma coleta para criar o primeiro snapshot.");

    const diff = getDiff(currentSnapshot);
    const summary = currentSnapshot.diffSummary || {};
    const baseline = !!summary.baseline;

    root.querySelector("#ia-content").innerHTML = `
      <section class="ia-page-head">
        <div><h2>Visão geral</h2><p>Última coleta: ${formatDate(currentSnapshot.createdAt)}</p></div>
        ${qualityBadge(currentSnapshot)}
      </section>

      <section class="ia-stats-grid">
        ${statCard(currentSnapshot.followers?.length, "Seguidores", "followers")}
        ${statCard(currentSnapshot.following?.length, "Seguindo", "following")}
        ${statCard(diff.notFollowingBack?.length, "Não seguem de volta", "notFollowingBack")}
        ${statCard(diff.unfollows?.length, "Unfollows", "unfollows")}
        ${statCard(onlyAccountsIFollow(diff.unfollows, currentSnapshot).length, "Unfollows de quem sigo", "followedUnfollows")}
      </section>

      <section class="ia-card">
        <h3>${baseline ? "Baseline criado" : "Diferença da última coleta válida"}</h3>
        ${baseline
          ? `<p>Esta é a primeira base válida deste perfil. As diferenças históricas começam na próxima coleta elegível.</p>`
          : `<div class="ia-diff-grid">
              <div><b>+${summary.newFollowers || 0}</b><span>novos seguidores</span></div>
              <div><b>-${summary.unfollows || 0}</b><span>unfollows detectados</span></div>
              <div><b>+${summary.youStartedFollowing || 0}</b><span>você começou a seguir</span></div>
              <div><b>-${summary.youUnfollowed || 0}</b><span>você deixou de seguir</span></div>
            </div>`}
      </section>

      ${confirmationBanner(currentSnapshot)}
      ${currentSnapshot.quality?.status !== "valid" ? `<section class="ia-card ia-quality-note"><h3>Qualidade da coleta</h3><p>${escapeHtml(currentSnapshot.quality?.reason || "Sem detalhes.")}</p></section>` : ""}
    `;

    root.querySelectorAll("[data-goto]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.goto)));
    bindConfirmationButtons(root.querySelector("#ia-content"));
  }

  function listForPage(page, snapshot = currentSnapshot) {
    const diff = getDiff(snapshot);
    const map = {
      followers: snapshot?.followers || [],
      following: snapshot?.following || [],
      notFollowingBack: diff.notFollowingBack || [],
      unfollows: diff.unfollows || [],
      followedUnfollows: onlyAccountsIFollow(diff.unfollows, snapshot),
      newFollowers: diff.newFollowers || [],
      youUnfollowed: diff.youUnfollowed || [],
      youStartedFollowing: diff.youStartedFollowing || []
    };
    return map[page] || [];
  }

  function pageLabel(page) {
    return pages.find(([id]) => id === page)?.[1] || "Lista";
  }

  function renderListPage(page) {
    if (!currentSnapshot) return emptyState("Faça uma coleta primeiro.");

    const source = listForPage(page);
    const pendingSource = isConfirmationPage(page)
      ? pendingListForPage(page)
      : [];

    const q = filterText.trim().toLowerCase();

    const applyFilter = (list) => q
      ? list.filter((u) =>
          `${u.username || ""} ${u.fullName || ""}`
            .toLowerCase()
            .includes(q)
        )
      : list;

    const filtered = applyFilter(source);
    const pendingFiltered = applyFilter(pendingSource);
    const hasConfirmationContext = isConfirmationPage(page);

    root.querySelector("#ia-content").innerHTML = `
      <section class="ia-page-head">
        <div>
          <h2>${escapeHtml(pageLabel(page))}</h2>
          <p>
            ${source.length.toLocaleString("pt-BR")} confirmado(s)
            ${hasConfirmationContext && pendingSource.length
              ? ` · ${pendingSource.length.toLocaleString("pt-BR")} aguardando confirmação`
              : ""}
          </p>
        </div>
      </section>

      ${["unfollows", "followedUnfollows"].includes(page) ? `<section class="ia-info-note">A ausência na lista é detectada por comparação. Conta desativada, removida, bloqueio ou indisponibilidade podem parecer um unfollow; por isso esta lista deve ser lida como <strong>unfollows detectados</strong>, não confirmação absoluta.</section>` : ""}

      ${hasConfirmationContext && pendingSource.length
        ? `<section class="ia-confirmation-banner compact">
            <div class="ia-confirmation-icon">✓?</div>
            <div class="ia-confirmation-copy">
              <strong>${pendingSource.length.toLocaleString("pt-BR")} ${escapeHtml(pendingTypeLabel(page, pendingSource.length))} aguardando confirmação</strong>
              <span>Esses perfis já foram detectados, mas ainda não são tratados como mudança real. <b>Faça uma nova coleta</b>; a confirmação acontece automaticamente se eles permanecerem com o mesmo estado.</span>
            </div>
            <button class="ia-confirm-now" data-confirm-collect>Confirmar com nova coleta</button>
          </section>`
        : ""}

      ${page === "followedUnfollows" ? `<section class="ia-info-note">Aqui aparecem apenas perfis que sumiram da sua lista de seguidores e que você <strong>ainda segue</strong>. Não é uma análise dos seguidores de outras pessoas.</section>` : ""}
      <div class="ia-filter-wrap">
        <input id="ia-filter" value="${escapeHtml(filterText)}" placeholder="Buscar por usuário ou nome">
      </div>

      ${hasConfirmationContext
        ? `<section class="ia-confirmation-section">
            <div class="ia-section-title">
              <div>
                <strong>Confirmados</strong>
                <span>${source.length.toLocaleString("pt-BR")} perfis</span>
              </div>
              <span class="ia-state-pill confirmed">Confirmado</span>
            </div>
            <section class="ia-user-list">
              ${filtered.length
                ? filtered.map((user) => renderUser(user)).join("")
                : `<div class="ia-empty">Nenhuma mudança confirmada nesta categoria.</div>`}
            </section>
          </section>

          <section class="ia-confirmation-section">
            <div class="ia-section-title">
              <div>
                <strong>Aguardando confirmação</strong>
                <span>${pendingSource.length.toLocaleString("pt-BR")} perfis · confirmação automática na próxima coleta válida</span>
              </div>
              <span class="ia-state-pill pending">Pendente</span>
            </div>
            <section class="ia-user-list">
              ${pendingFiltered.length
                ? pendingFiltered.map((user) => renderUser(user, { pending: true })).join("")
                : `<div class="ia-empty">Nenhuma mudança aguardando confirmação.</div>`}
            </section>
          </section>`
        : `<section class="ia-user-list">
            ${filtered.length
              ? filtered.map((user) => renderUser(user)).join("")
              : `<div class="ia-empty">Nada para mostrar.</div>`}
          </section>`}
    `;

    root.querySelector("#ia-filter")?.addEventListener("input", (event) => {
      filterText = event.target.value || "";
      const position = event.target.selectionStart;
      renderListPage(page);
      const input = root.querySelector("#ia-filter");
      input?.focus();
      if (input && position !== null) input.setSelectionRange(position, position);
    });

    bindConfirmationButtons(root.querySelector("#ia-content"));
  }

  function renderUser(user, options = {}) {
    const username = escapeHtml(user.username || "");
    const fullName = escapeHtml(user.fullName || "");
    const avatar = user.profilePic
      ? `<img src="${escapeHtml(user.profilePic)}" alt="@${username}">`
      : `<div class="ia-user-avatar">${escapeHtml(username?.[0]?.toUpperCase() || "?")}</div>`;

    return `
      <div class="ia-user-row${options.pending ? " pending" : ""}">
        ${avatar}
        <div class="ia-user-copy">
          <strong>@${username}</strong>
          <span>${fullName}</span>
          ${options.pending
            ? `<span class="ia-pending-copy">Detectado na última coleta · aguardando a próxima coleta válida</span>`
            : ""}
        </div>
        <div class="ia-user-actions">
          ${options.pending ? `<span class="ia-state-pill pending">Pendente</span>` : ""}
          <a href="https://www.instagram.com/${username}/" target="_blank" rel="noreferrer">Abrir</a>
        </div>
      </div>
    `;
  }

  function renderHistory() {
    if (!currentHistory.length) return emptyState("Nenhuma coleta salva para este perfil.");

    root.querySelector("#ia-content").innerHTML = `
      <section class="ia-page-head"><div><h2>Histórico de coletas</h2><p>${currentHistory.length} loads salvos</p></div></section>
      <section class="ia-history-list">
        ${currentHistory.map((snapshot, index) => {
          const summary = snapshot.diffSummary || {};
          return `<button class="ia-history-card" data-history-id="${escapeHtml(snapshot.id)}">
            <div class="ia-history-top"><div><strong>${index === 0 ? "Atual" : `Coleta #${currentHistory.length - index}`}</strong><span>${formatDate(snapshot.createdAt)}</span></div>${qualityBadge(snapshot)}</div>
            <div class="ia-history-counts"><span><b>${snapshot.followers?.length || 0}</b> seguidores</span><span><b>${snapshot.following?.length || 0}</b> seguindo</span></div>
            <div class="ia-history-diffs">
              <span>+${summary.newFollowers || 0} novos</span>
              <span>-${summary.unfollows || 0} unfollows</span>
              <span>+${summary.youStartedFollowing || 0} seguindo</span>
              <span>-${summary.youUnfollowed || 0} deixou de seguir</span>
            </div>
            ${pendingSummary(snapshot).total
              ? `<div class="ia-history-pending">
                  <span class="ia-state-pill pending">Pendente</span>
                  <strong>${pendingSummary(snapshot).total} mudança(s) aguardando confirmação</strong>
                  <span>Faça uma nova coleta válida para confirmar automaticamente.</span>
                </div>`
              : ""}
            <span class="ia-history-open">Ver detalhes →</span>
          </button>`;
        }).join("")}
      </section>
    `;

    root.querySelectorAll("[data-history-id]").forEach((button) => {
      button.addEventListener("click", () => openHistoryDetail(button.dataset.historyId));
    });
  }

  function historyFilterButtons(snapshot) {
    const items = [
      ["all", "Resumo"],
      ["unfollows", `Unfollows (${listForPage("unfollows", snapshot).length})`],
      ["newFollowers", `Novos (${listForPage("newFollowers", snapshot).length})`],
      ["youStartedFollowing", `Começou a seguir (${listForPage("youStartedFollowing", snapshot).length})`],
      ["youUnfollowed", `Deixou de seguir (${listForPage("youUnfollowed", snapshot).length})`],
      ["notFollowingBack", `Não seguem de volta (${listForPage("notFollowingBack", snapshot).length})`]
    ];

    return items.map(([id, label]) =>
      `<button class="ia-detail-tab${historyDetailFilter === id ? " active" : ""}" data-detail-filter="${id}">${escapeHtml(label)}</button>`
    ).join("");
  }

  function renderHistoryDetail() {
    const snapshot = currentHistory.find((item) => item.id === historyDetailId);
    if (!snapshot) return renderHistory();

    const summary = snapshot.diffSummary || {};
    const previous = currentHistory.find((item) => item.id === snapshot.previousEligibleId) || null;
    const diff = getDiff(snapshot);

    let body = `
      <section class="ia-card">
        <div class="ia-history-detail-stats">
          <div><b>${Number(snapshot.followers?.length || 0).toLocaleString("pt-BR")}</b><span>Seguidores</span></div>
          <div><b>${Number(snapshot.following?.length || 0).toLocaleString("pt-BR")}</b><span>Seguindo</span></div>
          <div><b>${Number(diff.notFollowingBack?.length || 0).toLocaleString("pt-BR")}</b><span>Não seguem de volta</span></div>
          <div><b>-${Number(summary.unfollows || 0).toLocaleString("pt-BR")}</b><span>Unfollows</span></div>
        </div>
      </section>
    `;

    if (historyDetailFilter !== "all") {
      const list = listForPage(historyDetailFilter, snapshot);
      body = `
        <div class="ia-filter-wrap"><input id="ia-detail-search" value="${escapeHtml(filterText)}" placeholder="Buscar por usuário ou nome"></div>
        <section class="ia-user-list">
          ${(filterText
            ? list.filter((u) => `${u.username || ""} ${u.fullName || ""}`.toLowerCase().includes(filterText.toLowerCase()))
            : list
          ).map(renderUser).join("") || `<div class="ia-empty">Nada para mostrar nesta coleta.</div>`}
        </section>
      `;
    }

    root.querySelector("#ia-content").innerHTML = `
      <button class="ia-back-button" id="ia-history-back">← Voltar ao histórico</button>

      <section class="ia-page-head ia-history-detail-head">
        <div>
          <h2>Detalhes da coleta</h2>
          <p>${formatDate(snapshot.createdAt)}</p>
          <p>${previous ? `Comparada com ${formatDate(previous.createdAt)}` : "Primeiro baseline elegível"}</p>
        </div>
        ${qualityBadge(snapshot)}
      </section>

      ${confirmationBanner(snapshot, true)}
      <section class="ia-detail-tabs">${historyFilterButtons(snapshot)}</section>
      ${body}
    `;

    root.querySelector("#ia-history-back").onclick = () => navigate("history");
    bindConfirmationButtons(root.querySelector("#ia-content"));

    root.querySelectorAll("[data-detail-filter]").forEach((button) => {
      button.onclick = () => {
        historyDetailFilter = button.dataset.detailFilter;
        filterText = "";
        renderHistoryDetail();
      };
    });

    root.querySelector("#ia-detail-search")?.addEventListener("input", (event) => {
      filterText = event.target.value || "";
      const position = event.target.selectionStart;
      renderHistoryDetail();
      const input = root.querySelector("#ia-detail-search");
      input?.focus();
      if (input && position !== null) input.setSelectionRange(position, position);
    });
  }

  function openHistoryDetail(id) {
    historyDetailId = id;
    historyDetailFilter = "all";
    filterText = "";
    currentPage = "history-detail";
    root.querySelectorAll(".ia-menu-item").forEach((button) => button.classList.toggle("active", button.dataset.page === "history"));
    renderHistoryDetail();
  }

  function emptyState(message) {
    root.querySelector("#ia-content").innerHTML = `<div class="ia-empty-page"><strong>Nada por aqui ainda</strong><p>${escapeHtml(message)}</p></div>`;
  }

  function navigate(page) {
    currentPage = page;
    historyDetailId = null;
    historyDetailFilter = "all";
    filterText = "";
    root.querySelectorAll(".ia-menu-item").forEach((button) => button.classList.toggle("active", button.dataset.page === page));
    if (page === "overview") renderOverview();
    else if (page === "history") renderHistory();
    else renderListPage(page);
  }

  async function setData(snapshot, history = []) {
    currentSnapshot = snapshot || null;
    currentHistory = Array.isArray(history) ? history : [];
    renderProfile(currentSnapshot);

    if (currentPage === "history-detail" && historyDetailId) renderHistoryDetail();
    else navigate(currentPage || "overview");
  }


  function setDetectedInstagramAccount(account) {
    detectedInstagramAccount = account || null;
    ensurePanel();
    const box = root.querySelector("#ia-detected-account");
    if (!box) return;

    if (!account?.username) {
      box.innerHTML = `<div class="ia-user-avatar">?</div><div><strong>Conta não detectada</strong><span>Faça login no Instagram e clique em Atualizar usuário.</span></div>`;
      renderAuth();
      return;
    }

    const username = escapeHtml(account.username);
    const fullName = escapeHtml(account.fullName || "Conta do Instagram detectada");
    const avatar = account.profilePic
      ? `<img class="ia-detected-avatar" src="${escapeHtml(account.profilePic)}" alt="@${username}">`
      : `<div class="ia-user-avatar">${escapeHtml(username?.[0]?.toUpperCase() || "?")}</div>`;
    box.innerHTML = `${avatar}<div><strong>@${username}</strong><span>${fullName}</span></div>`;
    renderAuth();
  }

  function formatMoney(value) {
    return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  async function renderAuth() {
    ensurePanel();
    const box = root.querySelector("#ia-auth-box");
    const cfg = IA.getSupabaseConfig?.() || { configured: false };
    const session = await IA.getAuthSession?.();
    const access = await IA.getCollectionAccess?.(detectedInstagramAccount).catch(() => null);

    if (!cfg.configured) {
      const guest = access;
      box.innerHTML = `
        <strong>Teste sem conta</strong>
        <span>${guest ? IA.quotaText(guest) : "Até 10 coletas locais"}</span>
        <span>Configure o Supabase para liberar login, planos e sincronização.</span>
      `;
      return;
    }

    if (session?.user?.email) {
      const plan = access?.planCode || "pending";
      const planLabel = plan === "pro" ? "PRO" : plan === "free" ? "FREE" : "Sem plano";
      const paidUntil = access?.paidUntil ? ` até ${new Date(access.paidUntil).toLocaleDateString("pt-BR")}` : "";
      const quota = access ? IA.quotaText(access) : "";

      box.innerHTML = `
        <div class="ia-account-head">
          <strong>${escapeHtml(session.user.email)}</strong>
          <span class="ia-plan-pill ${plan === "pro" ? "pro" : ""}">${planLabel}</span>
        </div>
        <span>${plan === "pro" ? `Plano PRO ativo${paidUntil}.` : plan === "free" ? "Plano FREE ativo." : "Conta criada. Assine o PRO para liberar o plano pago."}</span>
        ${quota ? `<span>${escapeHtml(quota)}</span>` : ""}
        ${plan !== "pro" ? `<button id="ia-buy-pro" class="ia-buy-button">Assinar PRO${access?.proPrice ? ` · ${formatMoney(access.proPrice)}` : ""}</button>` : ""}
        <button id="ia-refresh-plan" class="ia-secondary">Atualizar plano</button>
        <button id="ia-logout" class="ia-text-button">Sair</button>
        <span id="ia-billing-status"></span>
      `;

      box.querySelector("#ia-logout").onclick = async () => {
        await IA.signOut();
        await renderAuth();
        setStatus("Sessão Supabase encerrada.");
      };

      box.querySelector("#ia-refresh-plan").onclick = async () => {
        await IA.getProductSettings?.(true);
        await renderAuth();
        setStatus("Plano atualizado.", "success");
      };

      const buy = box.querySelector("#ia-buy-pro");
      if (buy) {
        buy.onclick = async () => {
          const status = box.querySelector("#ia-billing-status");
          buy.disabled = true;
          status.textContent = "Abrindo Mercado Pago...";
          try {
            await IA.createProCheckout();
            status.textContent = "Checkout aberto. Depois do pagamento, clique em Atualizar plano.";
          } catch (error) {
            status.textContent = error.message;
          } finally {
            buy.disabled = false;
          }
        };
      }

      return;
    }

    const guestText = access ? IA.quotaText(access) : "10 coletas gratuitas";

    box.innerHTML = `
      <strong>Teste grátis</strong>
      <span>${escapeHtml(guestText)}</span>
      <span>Você pode testar sem conta. Para assinar o PRO, crie sua conta e pague pelo Mercado Pago.</span>
      <input id="ia-auth-email" type="email" placeholder="E-mail">
      <input id="ia-auth-password" type="password" placeholder="Senha">
      <div class="ia-auth-actions"><button id="ia-login-btn">Entrar</button><button id="ia-signup-btn" class="ia-secondary">Criar conta</button></div>
      <span id="ia-auth-status"></span>
    `;

    const authStatus = box.querySelector("#ia-auth-status");
    const credentials = () => ({
      email: box.querySelector("#ia-auth-email").value.trim(),
      password: box.querySelector("#ia-auth-password").value
    });

    box.querySelector("#ia-login-btn").onclick = async () => {
      try {
        const { email, password } = credentials();
        await IA.signIn(email, password);
        await renderAuth();
        setStatus("Login realizado.", "success");
      } catch (error) { authStatus.textContent = error.message; }
    };

    box.querySelector("#ia-signup-btn").onclick = async () => {
      try {
        const { email, password } = credentials();
        const result = await IA.signUp(email, password);
        authStatus.textContent = result?.access_token
          ? "Conta criada. Agora você pode assinar o PRO."
          : "Conta criada. Confirme o e-mail e depois faça login para assinar.";
        if (result?.access_token) await renderAuth();
      } catch (error) { authStatus.textContent = error.message; }
    };
  }

  Object.assign(IA, {
    ensurePanel,
    togglePanel: toggle,
    setPanelStatus: setStatus,
    setPanelProgress: setProgress,
    setCollecting,
    setPanelData: setData,
    renderAuthPanel: renderAuth,
    navigatePanel: navigate,
    setDetectedInstagramAccount
  });
})();

