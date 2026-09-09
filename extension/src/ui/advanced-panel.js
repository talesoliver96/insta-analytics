window.InstaAnalytics = window.InstaAnalytics || {};
(() => {
  const IA = window.InstaAnalytics;
  const originalEnsure = IA.ensurePanel;
  const originalSetData = IA.setPanelData;
  const originalNavigate = IA.navigatePanel;
  let root = null;
  let snapshot = null;
  let history = [];
  let activeAdvanced = null;
  let selectedUser = null;

  const esc = (v = "") => String(v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const fmt = (v) => new Date(v).toLocaleString("pt-BR");
  const n = (v) => Number(v || 0).toLocaleString("pt-BR");

  const advancedPages = [
    ["analytics", "Analytics"],
    ["compare", "Comparar períodos"],
    ["silent", "Unfollows silenciosos"],
    ["watchlist", "Monitorados"],
    ["search", "Busca global"],
    ["notifications", "Notificações"],
    ["export", "Exportar dados"]
  ];

  function content() { return root?.querySelector("#ia-content"); }

  function setActive(id) {
    root.querySelectorAll(".ia-menu-item").forEach((b) => b.classList.toggle("active", b.dataset.advancedPage === id));
  }

  function inject(rootNode) {
    root = rootNode;
    if (root.dataset.v54Advanced === "1") return root;
    root.dataset.v54Advanced = "1";
    const menu = root.querySelector(".ia-menu");
    const divider = document.createElement("div"); divider.className = "ia-menu-divider"; menu.appendChild(divider);
    for (const [id, label] of advancedPages) {
      const b = document.createElement("button");
      b.className = "ia-menu-item"; b.dataset.advancedPage = id; b.textContent = label;
      b.onclick = () => navigateAdvanced(id);
      menu.appendChild(b);
    }
    maybeAddAdmin();
    return root;
  }

  async function maybeAddAdmin() {
    if (!root || root.querySelector('[data-advanced-page="admin"]')) return;
    if (!await IA.isAdmin?.()) return;
    const menu = root.querySelector(".ia-menu");
    const b = document.createElement("button"); b.className = "ia-menu-item"; b.dataset.advancedPage = "admin"; b.textContent = "Admin SaaS";
    b.onclick = () => navigateAdvanced("admin"); menu.appendChild(b);
  }

  IA.ensurePanel = function() { return inject(originalEnsure()); };
  IA.setPanelData = async function(s, h = []) {
    history = IA.rebuildReliableHistory ? IA.rebuildReliableHistory(h) : h;
    snapshot = history[0] || s || null;
    if (activeAdvanced) return renderAdvanced(activeAdvanced);
    return originalSetData(snapshot, history);
  };
  IA.navigatePanel = function(page) {
    if ([...advancedPages.map((x) => x[0]), "admin", "profile360"].includes(page)) return navigateAdvanced(page);
    activeAdvanced = null;
    return originalNavigate(page);
  };

  function navigateAdvanced(page) {
    activeAdvanced = page;
    setActive(page);
    renderAdvanced(page);
  }

  function chartSvg(series) {
    if (!series?.length) return "";
    const values = series.map((x) => Number(x.followers || 0));
    const min = Math.min(...values), max = Math.max(...values), range = Math.max(1, max - min);
    const width = 560, height = 140;
    const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * width},${height - ((v - min) / range) * (height - 18) - 9}`).join(" ");
    return `<svg class="ia-growth-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="3" vector-effect="non-scaling-stroke"/></svg>`;
  }

  function renderAnalytics() {
    if (!snapshot) return empty("Faça uma coleta para gerar Analytics.");
    const a = IA.getAnalytics?.(history);
    if (!a) return empty("Ainda não há dados suficientes.");
    const sign = (v) => `${v >= 0 ? "+" : ""}${n(v)}`;
    content().innerHTML = `
      <section class="ia-page-head"><div><h2>Analytics</h2><p>Dados acumulados desde a primeira coleta salva neste app.</p></div></section>
      <section class="ia-stats-grid ia-stats-grid-analytics">
        <div class="ia-stat-card"><b>${n(snapshot.followers?.length)}</b><span>Seguidores · ${sign(a.followersDelta)} no período</span></div>
        <div class="ia-stat-card"><b>${n(snapshot.following?.length)}</b><span>Seguindo · ${sign(a.followingDelta)} no período</span></div>
        <div class="ia-stat-card"><b>${n(a.mutual)}</b><span>Relações mútuas</span></div>
        <div class="ia-stat-card"><b>${a.reciprocity.toFixed(1)}%</b><span>Reciprocidade</span></div>
      </section>
      <section class="ia-card"><h3>Evolução de seguidores</h3>${chartSvg(a.series)}<p class="ia-chart-caption">${fmt(a.first.createdAt)} → ${fmt(a.latest.createdAt)}</p></section>
      <section class="ia-card"><h3>Relações atuais</h3><div class="ia-diff-grid">
        <div><b>${n(a.notFollowingBack)}</b><span>não seguem de volta</span></div>
        <div><b>${n(a.youDontFollowBack)}</b><span>você não segue de volta</span></div>
        <div><b>${n(a.totals.newFollowers)}</b><span>novos confirmados</span></div>
        <div><b>${n(a.totals.unfollows)}</b><span>unfollows confirmados</span></div>
      </div></section>
      <section class="ia-info-note">Mudanças individuais agora só aparecem depois de persistirem em duas coletas consecutivas. Isso reduz falsos positivos causados por paginação ou respostas incompletas do Instagram.</section>
    `;
  }

  function renderCompare() {
    if (history.length < 2) return empty("Faça pelo menos duas coletas para comparar períodos.");
    const options = history.map((s) => `<option value="${esc(s.id)}">${fmt(s.createdAt)} · ${n(s.followers?.length)} seguidores</option>`).join("");
    content().innerHTML = `
      <section class="ia-page-head"><div><h2>Comparar períodos</h2><p>Compare duas coletas salvas.</p></div></section>
      <section class="ia-card ia-compare-controls"><label>De<select id="ia-compare-from">${options}</select></label><label>Até<select id="ia-compare-to">${options}</select></label><button id="ia-run-compare" class="ia-primary">Comparar</button></section>
      <div id="ia-compare-result"></div>`;
    const from = root.querySelector("#ia-compare-from"), to = root.querySelector("#ia-compare-to");
    from.value = history[history.length - 1].id; to.value = history[0].id;
    root.querySelector("#ia-run-compare").onclick = () => {
      const a = history.find((s) => s.id === from.value), b = history.find((s) => s.id === to.value);
      const older = Number(a.createdAt) <= Number(b.createdAt) ? a : b;
      const newer = older === a ? b : a;
      const d = IA.compareSnapshotPair?.(older, newer);
      root.querySelector("#ia-compare-result").innerHTML = `<section class="ia-stats-grid"><div class="ia-stat-card"><b>${d.followersDelta >= 0 ? "+" : ""}${n(d.followersDelta)}</b><span>saldo seguidores</span></div><div class="ia-stat-card"><b>+${n(d.newFollowers.length)}</b><span>entraram entre endpoints</span></div><div class="ia-stat-card"><b>-${n(d.unfollows.length)}</b><span>saíram entre endpoints</span></div><div class="ia-stat-card"><b>${d.followingDelta >= 0 ? "+" : ""}${n(d.followingDelta)}</b><span>saldo seguindo</span></div></section><section class="ia-info-note">Comparação direta entre os dois snapshots selecionados. Para o histórico normal, o app continua usando confirmação temporal em duas coletas.</section>`;
    };
    root.querySelector("#ia-run-compare").click();
  }

  function userRow(user, extra = "") {
    const username = esc(user?.username || ""), name = esc(user?.fullName || "");
    const avatar = user?.profilePic ? `<img src="${esc(user.profilePic)}">` : `<div class="ia-user-avatar">${esc(username[0]?.toUpperCase() || "?")}</div>`;
    return `<div class="ia-user-row ia-user-row-click" data-user-id="${esc(user?.id || "")}" data-user-username="${username}">${avatar}<div class="ia-user-copy"><strong>@${username}</strong><span>${name}${extra ? ` · ${extra}` : ""}</span></div><button class="ia-mini-action" data-open360>Detalhes</button></div>`;
  }

  function bindUserRows(containerNode = root) {
    containerNode.querySelectorAll("[data-open360]").forEach((b) => b.onclick = (e) => {
      const row = e.currentTarget.closest(".ia-user-row-click");
      const user = findUser(row.dataset.userId, row.dataset.userUsername);
      if (user) openProfile360(user);
    });
  }

  function findUser(id, username) {
    const all = [snapshot?.followers || [], snapshot?.following || [], ...history.flatMap((s) => [...(s.followers || []), ...(s.following || [])])];
    return all.find((u) => id && String(u.id) === String(id)) || all.find((u) => String(u.username || "").toLowerCase() === String(username || "").toLowerCase()) || { id, username, fullName: "", profilePic: "" };
  }

  function renderSilent() {
    const list = IA.getSilentUnfollows?.(snapshot) || [];
    content().innerHTML = `<section class="ia-page-head"><div><h2>Unfollows silenciosos</h2><p>Deixaram de seguir você, mas você ainda segue. Somente mudanças confirmadas.</p></div></section><section class="ia-user-list">${list.map((u) => userRow(u, "você ainda segue")).join("") || '<div class="ia-empty">Nada para mostrar.</div>'}</section>`;
    bindUserRows();
  }

  async function renderWatchlist() {
    content().innerHTML = `<section class="ia-page-head"><div><h2>Monitorados</h2><p>Perfis marcados por você.</p></div></section><div class="ia-empty">Carregando...</div>`;
    const list = await IA.listWatchlist?.() || [];
    content().innerHTML = `<section class="ia-page-head"><div><h2>Monitorados</h2><p>${list.length} perfis</p></div></section><section class="ia-user-list">${list.map((a) => userRow(a.user, (a.tags || []).join(" · "))).join("") || '<div class="ia-empty">Nenhum perfil monitorado. Abra Detalhes de um usuário e marque como monitorado.</div>'}</section>`;
    bindUserRows();
  }

  function allKnownUsers() {
    const map = new Map();
    for (const s of history) for (const u of [...(s.followers || []), ...(s.following || [])]) {
      const key = String(u.id || u.username || "").toLowerCase(); if (key && !map.has(key)) map.set(key, u);
    }
    return [...map.values()];
  }

  function renderSearch() {
    content().innerHTML = `<section class="ia-page-head"><div><h2>Busca global</h2><p>Pesquise entre os perfis já observados nas suas coletas.</p></div></section><div class="ia-filter-wrap"><input id="ia-global-search" placeholder="Buscar @usuário ou nome"></div><section id="ia-global-results" class="ia-user-list"><div class="ia-empty">Digite para pesquisar.</div></section>`;
    const input = root.querySelector("#ia-global-search"), results = root.querySelector("#ia-global-results");
    input.oninput = () => {
      const q = input.value.trim().toLowerCase();
      const list = q ? allKnownUsers().filter((u) => `${u.username || ""} ${u.fullName || ""}`.toLowerCase().includes(q)).slice(0, 100) : [];
      results.innerHTML = list.map((u) => userRow(u)).join("") || `<div class="ia-empty">${q ? "Nenhum resultado." : "Digite para pesquisar."}</div>`;
      bindUserRows(results);
    };
  }

  async function openProfile360(user) {
    selectedUser = user; activeAdvanced = "profile360"; setActive("");
    const annotation = await IA.getAnnotation?.(user) || { watchlisted: false, tags: [], note: "" };
    const timeline = [...history].sort((a,b) => Number(b.createdAt)-Number(a.createdAt)).map((s) => ({ s, state: IA.relationState?.(s, user) || {} }));
    const current = timeline[0]?.state || {};
    content().innerHTML = `
      <button class="ia-back-button" id="ia-profile360-back">← Voltar</button>
      <section class="ia-page-head"><div><h2>@${esc(user.username)}</h2><p>${esc(user.fullName || "Perfil observado nas coletas")}</p></div><a class="ia-open-profile" href="https://www.instagram.com/${esc(user.username)}/" target="_blank">Abrir Instagram</a></section>
      <section class="ia-stats-grid"><div class="ia-stat-card"><b>${current.followsYou ? "Sim" : "Não"}</b><span>segue você agora</span></div><div class="ia-stat-card"><b>${current.youFollow ? "Sim" : "Não"}</b><span>você segue agora</span></div><div class="ia-stat-card"><b>${current.followsYou && current.youFollow ? "Sim" : "Não"}</b><span>relação mútua</span></div><div class="ia-stat-card"><b>${timeline.length}</b><span>coletas observadas</span></div></section>
      <section class="ia-card"><h3>Organização pessoal</h3><label class="ia-check"><input id="ia-watchlisted" type="checkbox" ${annotation.watchlisted ? "checked" : ""}> Monitorar este perfil</label><label>Tags<input id="ia-tags" class="ia-input" value="${esc((annotation.tags || []).join(", "))}" placeholder="amigo, cliente, influencer"></label><label>Nota<textarea id="ia-note" class="ia-textarea" placeholder="Nota privada">${esc(annotation.note || "")}</textarea></label><button id="ia-save-annotation" class="ia-primary">Salvar</button><span id="ia-annotation-status"></span></section>
      <section class="ia-card"><h3>Linha do tempo observada</h3><div class="ia-timeline">${timeline.map(({s,state}) => `<div><strong>${fmt(s.createdAt)}</strong><span>Segue você: ${state.followsYou ? "sim" : "não"} · Você segue: ${state.youFollow ? "sim" : "não"}</span></div>`).join("")}</div><p class="ia-chart-caption">A linha do tempo começa na primeira coleta feita pelo app; não afirma eventos anteriores.</p></section>`;
    root.querySelector("#ia-profile360-back").onclick = () => navigateAdvanced("search");
    root.querySelector("#ia-save-annotation").onclick = async () => {
      const value = { watchlisted: root.querySelector("#ia-watchlisted").checked, tags: root.querySelector("#ia-tags").value.split(","), note: root.querySelector("#ia-note").value };
      await IA.saveAnnotation?.(user, value); root.querySelector("#ia-annotation-status").textContent = "Salvo.";
    };
  }

  async function renderNotifications() {
    let list = await IA.listNotifications?.() || [];
    content().innerHTML = `<section class="ia-page-head"><div><h2>Notificações</h2><p>Mudanças confirmadas detectadas nas coletas.</p></div><button id="ia-read-all" class="ia-secondary-action">Marcar como lidas</button></section><section class="ia-user-list">${list.map((x) => userRow(x.user, `${x.label} · ${fmt(x.createdAt)}`)).join("") || '<div class="ia-empty">Nenhuma mudança confirmada ainda.</div>'}</section>`;
    bindUserRows();
    root.querySelector("#ia-read-all").onclick = async () => { await IA.markNotificationsRead?.(); renderNotifications(); };
  }

  function renderExport() {
    content().innerHTML = `<section class="ia-page-head"><div><h2>Exportar dados</h2><p>Exporte seu histórico e mudanças confirmadas.</p></div></section><section class="ia-card"><h3>Histórico completo</h3><p>JSON com snapshots, listas e diferenças.</p><button id="ia-export-json" class="ia-primary">Exportar JSON</button></section><section class="ia-card"><h3>Mudanças confirmadas</h3><p>CSV compatível com Excel/Google Sheets.</p><button id="ia-export-csv" class="ia-primary">Exportar CSV</button></section>`;
    root.querySelector("#ia-export-json").onclick = () => IA.exportHistoryJson?.(snapshot?.username || "instagram", history);
    root.querySelector("#ia-export-csv").onclick = () => IA.exportChangesCsv?.(snapshot?.username || "instagram", history);
  }

  async function renderAdmin() {
    content().innerHTML = `<section class="ia-page-head"><div><h2>Admin SaaS</h2><p>Carregando...</p></div></section>`;
    try {
      const summary = await IA.adminRpc("get_admin_summary", {});
      const users = await IA.adminRpc("admin_list_accounts", {});
      const s = Array.isArray(summary) ? summary[0] : summary;
      content().innerHTML = `<section class="ia-page-head"><div><h2>Admin SaaS</h2><p>Gestão básica de contas e PRO.</p></div></section><section class="ia-stats-grid"><div class="ia-stat-card"><b>${n(s?.total_users)}</b><span>usuários</span></div><div class="ia-stat-card"><b>${n(s?.active_pro)}</b><span>PRO ativos</span></div><div class="ia-stat-card"><b>${n(s?.approved_payments)}</b><span>pagamentos aprovados</span></div><div class="ia-stat-card"><b>R$ ${Number(s?.approved_revenue || 0).toFixed(2)}</b><span>receita aprovada</span></div></section><section class="ia-card"><h3>Conceder PRO</h3><div class="ia-admin-grid"><input id="ia-admin-email" class="ia-input" placeholder="email@cliente.com"><input id="ia-admin-days" class="ia-input" type="number" value="30" min="1"><select id="ia-admin-limit"><option value="">Limite padrão do PRO</option><option value="0">Ilimitado para esta conta</option><option value="100">100/mês</option><option value="500">500/mês</option></select><label class="ia-check"><input id="ia-admin-lifetime" type="checkbox"> Vitalício</label><button id="ia-admin-grant" class="ia-primary">Conceder</button></div><span id="ia-admin-status"></span></section><section class="ia-user-list">${(users || []).map((u) => `<div class="ia-admin-user"><div><strong>${esc(u.email || "")}</strong><span>${esc(u.plan_code || "sem plano")} · ${u.lifetime ? "vitalício" : u.paid_until ? new Date(u.paid_until).toLocaleDateString("pt-BR") : "sem validade"}</span></div><button data-revoke="${esc(u.email || "")}" class="ia-mini-action">Remover PRO</button></div>`).join("") || '<div class="ia-empty">Nenhuma conta.</div>'}</section>`;
      root.querySelector("#ia-admin-grant").onclick = async () => {
        const email = root.querySelector("#ia-admin-email").value.trim(); const lifetime = root.querySelector("#ia-admin-lifetime").checked;
        const days = Number(root.querySelector("#ia-admin-days").value || 30); const raw = root.querySelector("#ia-admin-limit").value; const limit = raw === "" ? null : Number(raw);
        await IA.adminRpc("admin_grant_pro", { p_email: email, p_days: days, p_lifetime: lifetime, p_collection_limit_override: limit });
        root.querySelector("#ia-admin-status").textContent = "PRO atualizado."; setTimeout(renderAdmin, 500);
      };
      root.querySelectorAll("[data-revoke]").forEach((b) => b.onclick = async () => { await IA.adminRpc("admin_revoke_pro", { p_email: b.dataset.revoke }); renderAdmin(); });
    } catch (error) { content().innerHTML = `<div class="ia-empty-page"><strong>Admin indisponível</strong><p>${esc(error.message)}</p></div>`; }
  }

  function empty(message) { content().innerHTML = `<div class="ia-empty-page"><strong>Nada por aqui ainda</strong><p>${esc(message)}</p></div>`; }

  function renderAdvanced(page) {
    if (!root) root = IA.ensurePanel();
    if (page === "analytics") return renderAnalytics();
    if (page === "compare") return renderCompare();
    if (page === "silent") return renderSilent();
    if (page === "watchlist") return renderWatchlist();
    if (page === "search") return renderSearch();
    if (page === "notifications") return renderNotifications();
    if (page === "export") return renderExport();
    if (page === "admin") return renderAdmin();
    if (page === "profile360" && selectedUser) return openProfile360(selectedUser);
  }
})();
