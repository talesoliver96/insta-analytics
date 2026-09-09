(() => {
  if (window.__instaAnalyticsV55) return;
  window.__instaAnalyticsV55 = true;

  const IA = window.InstaAnalytics;
  const root = IA.ensurePanel();
  let detectedAccount = null;

  async function loadAccountIntoPanel(username) {
    const normalized = IA.normalizeAccountKey(username);
    if (!normalized) return;

    const snapshots = await IA.loadLocalSnapshots(normalized);
    const rebuilt = IA.rebuildReliableHistory
      ? IA.rebuildReliableHistory(snapshots)
      : snapshots;

    await IA.setPanelData(rebuilt[0] || null, rebuilt);
  }

  async function detectOwnAccount({ silent = false } = {}) {
    try {
      if (!silent) {
        IA.setPanelStatus("Detectando sua conta do Instagram...");
      }

      const detected = await IA.detectCurrentInstagramAccount();
      const resolved = await IA.resolveProfile(detected.username);

      if (String(resolved.userId) !== String(detected.userId)) {
        const error = new Error(
          "A conta detectada não corresponde ao perfil resolvido."
        );
        error.code = "INSTAGRAM_ACCOUNT_MISMATCH";
        throw error;
      }

      detectedAccount = {
        userId: String(resolved.userId),
        username: resolved.profileInfo.username,
        fullName: resolved.profileInfo.fullName,
        profilePic: resolved.profileInfo.profilePic,
        isPrivate: resolved.profileInfo.isPrivate,
        isVerified: resolved.profileInfo.isVerified,
        profileInfo: resolved.profileInfo
      };

      IA.setDetectedInstagramAccount(detectedAccount);
      await IA.saveLocalAccount(resolved.profileInfo, resolved.userId);
      await loadAccountIntoPanel(detectedAccount.username);
      await IA.renderAuthPanel();

      if (!silent) {
        IA.setPanelStatus(
          `Conta detectada: @${detectedAccount.username}`,
          "success"
        );
      }

      return detectedAccount;
    } catch (error) {
      detectedAccount = null;
      IA.setDetectedInstagramAccount(null);

      if (!silent) {
        IA.setPanelStatus(
          `Não foi possível detectar sua conta: ${error.message}`,
          "error"
        );
      }

      throw error;
    }
  }

  root.querySelector("#ia-refresh-instagram").onclick = () =>
    detectOwnAccount().catch(() => {});

  root.querySelector("#ia-collect").onclick = async () => {
    let access = null;

    IA.setCollecting(true);
    IA.setPanelProgress(null);

    try {
      if (!detectedAccount?.userId) {
        await detectOwnAccount({ silent: true });
      }

      if (!detectedAccount?.userId) {
        throw new Error(
          "Faça login no Instagram e clique em Atualizar usuário."
        );
      }

      const username = detectedAccount.username;

      IA.setPanelStatus("Verificando limite de coletas...");
      access = await IA.checkCollectionPermission(detectedAccount);

      IA.setPanelStatus(`Confirmando @${username}...`);

      const { userId, profileInfo } = await IA.resolveProfile(username);

      if (String(userId) !== String(detectedAccount.userId)) {
        const error = new Error(
          "A conta do Instagram mudou. Clique em Atualizar usuário e tente novamente."
        );
        error.code = "INSTAGRAM_ACCOUNT_MISMATCH";
        throw error;
      }

      IA.setPanelStatus("Coletando seguidores...");
      IA.setPanelProgress({
        label: "Seguidores",
        collected: 0,
        expected: profileInfo.followerCount
      });

      const followersResult = await IA.collectFriendships(
        userId,
        "followers",
        (progress) => {
          IA.setPanelStatus(
            `Coletando seguidores... ${progress.collected.toLocaleString("pt-BR")}` +
            `${progress.expectedCount !== null ? ` / ${progress.expectedCount.toLocaleString("pt-BR")}` : ""}`
          );

          IA.setPanelProgress({
            label: "Seguidores",
            collected: progress.collected,
            expected: profileInfo.followerCount
          });
        },
        {
          expectedCount: profileInfo.followerCount
        }
      );

      IA.setPanelStatus("Coletando seguindo...");
      IA.setPanelProgress({
        label: "Seguindo",
        collected: 0,
        expected: profileInfo.followingCount
      });

      const followingResult = await IA.collectFriendships(
        userId,
        "following",
        (progress) => {
          IA.setPanelStatus(
            `Coletando seguindo... ${progress.collected.toLocaleString("pt-BR")}` +
            `${progress.expectedCount !== null ? ` / ${progress.expectedCount.toLocaleString("pt-BR")}` : ""}`
          );

          IA.setPanelProgress({
            label: "Seguindo",
            collected: progress.collected,
            expected: profileInfo.followingCount
          });
        },
        {
          expectedCount: profileInfo.followingCount
        }
      );

      const snapshot = IA.createSnapshot({
        username,
        userId,
        profileInfo,
        followersResult,
        followingResult
      });

      const existing = IA.rebuildReliableHistory
        ? IA.rebuildReliableHistory(
            await IA.loadLocalSnapshots(username)
          )
        : await IA.loadLocalSnapshots(username);

      const qualityStatus =
        snapshot?.quality?.status || "unknown";

      const comparisonEligible =
        snapshot?.quality?.comparisonEligible === true;

      if (
        qualityStatus === "suspicious" ||
        !comparisonEligible
      ) {
        await IA.setPanelData(snapshot, existing);
        IA.navigatePanel("overview");
        await IA.renderAuthPanel();

        const reason =
          snapshot?.quality?.reason ||
          "A coleta não passou na validação de integridade.";

        IA.setPanelStatus(
          `Coleta descartada: ${reason}`,
          "warning"
        );

        return;
      }

      const reliable = IA.buildReliableDiff(
        snapshot,
        existing
      );

      IA.attachReliableSnapshotDiff(snapshot, reliable);

      const savedRaw = await IA.saveLocalSnapshot(
        username,
        snapshot
      );

      const saved = IA.rebuildReliableHistory
        ? IA.rebuildReliableHistory(savedRaw)
        : savedRaw;

      let usageMessage = "";

      try {
        await IA.commitCollectionUse(access, snapshot);
      } catch (usageError) {
        usageMessage =
          ` · aviso de limite: ${usageError.message}`;
      }

      let syncMessage = "";

      try {
        if (access?.syncAllowed) {
          const session = await IA.getAuthSession();

          if (
            session?.user?.id &&
            IA.getSupabaseConfig().configured
          ) {
            await IA.syncSnapshotToSupabase(snapshot);
            syncMessage = " · sincronizada no Supabase";
          }
        }
      } catch (syncError) {
        syncMessage =
          ` · salva localmente; sync falhou: ${syncError.message}`;
      }

      try {
        await IA.recordNotificationsForSnapshot?.(snapshot);
      } catch (error) {
        console.warn(
          "[Insta Analytics] notifications:",
          error
        );
      }

      await IA.setPanelData(saved[0], saved);
      IA.navigatePanel("overview");
      await IA.renderAuthPanel();

      const quality =
        snapshot.quality?.status || "unknown";

      const label =
        quality === "valid"
          ? "válida"
          : quality === "unverified"
            ? "válida sem contador"
            : quality;

      const confirmed =
        (snapshot.diffSummary?.newFollowers || 0) +
        (snapshot.diffSummary?.unfollows || 0) +
        (snapshot.diffSummary?.youStartedFollowing || 0) +
        (snapshot.diffSummary?.youUnfollowed || 0);

      const pending =
        (snapshot.diffSummary?.pendingNewFollowers || 0) +
        (snapshot.diffSummary?.pendingUnfollows || 0) +
        (snapshot.diffSummary?.pendingYouStartedFollowing || 0) +
        (snapshot.diffSummary?.pendingYouUnfollowed || 0);

      const diffMsg = pending
        ? ` · ${pending} mudança(s) aguardando confirmação — faça uma nova coleta para confirmar`
        : confirmed
          ? ` · ${confirmed} mudança(s) confirmada(s)`
          : "";

      IA.setPanelStatus(
        `Coleta concluída (${label})${diffMsg}${syncMessage}${usageMessage}.`,
        quality === "suspicious"
          ? "warning"
          : "success"
      );
    } catch (error) {
      if (error.code === "COLLECTION_LIMIT") {
        IA.setPanelStatus(error.message, "warning");
        await IA.renderAuthPanel();
      } else if (error.code === "RATE_LIMITED") {
        IA.setPanelStatus(
          "O Instagram limitou temporariamente as requisições. Aguarde antes de tentar novamente.",
          "warning"
        );
      } else if (error.code === "INSTAGRAM_TEMPORARILY_BLOCKED") {
        IA.setPanelStatus(
          "O Instagram não disponibilizou temporariamente esta lista. Nenhuma coleta foi salva ou contabilizada. Tente novamente mais tarde.",
          "warning"
        );
      } else if (
        [
          "INSTAGRAM_AUTH",
          "INSTAGRAM_ACCOUNT_MISMATCH",
          "INSTAGRAM_ACCOUNT_NOT_DETECTED"
        ].includes(error.code)
      ) {
        IA.setPanelStatus(error.message, "error");
      } else {
        IA.setPanelStatus(
          `Erro: ${error.message}`,
          "error"
        );
      }
    } finally {
      IA.setPanelProgress(null);
      IA.setCollecting(false);
    }
  };

  (async () => {
    try {
      const optimized = await IA.optimizeLocalSnapshotStorage?.();

      if (optimized?.savedBytes > 0) {
        console.info(
          "[Insta Analytics] storage otimizado:",
          `${Math.round(optimized.beforeBytes / 1024)} KB -> ${Math.round(optimized.afterBytes / 1024)} KB`
        );
      }
    } catch (error) {
      console.warn(
        "[Insta Analytics] não foi possível otimizar o cache local:",
        error
      );
    }

    detectOwnAccount({ silent: true }).catch(() => {});
  })();

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "toggle-panel") {
      IA.togglePanel();

      if (!detectedAccount?.userId) {
        detectOwnAccount({ silent: true }).catch(() => {});
      }
    }
  });
})();
