(() => {
  if (window.__instaAnalyticsV55) return;
  window.__instaAnalyticsV55 = true;

  const IA = window.InstaAnalytics;
  const root = IA.ensurePanel();
  let detectedAccount = null;
  // Cached accounts are for read-only history, never authorization to collect.
  async function showOfflineHistory() {
    const data = await chrome.storage.local.get("ia_accounts_v1");
    const accounts = Object.values(data.ia_accounts_v1 || {}).filter(a => a?.username && a?.userId);
    // Never guess among multiple Instagram identities.
    if (accounts.length !== 1) return;
    const account = accounts[0];
    await loadAccountIntoPanel(account.username);
    IA.setPanelStatus(`Histórico salvo de @${account.username} disponível em modo leitura. Para coletar, confirme sua sessão do Instagram em Atualizar usuário.`, "error");
  }


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
      const gate = await IA.getInstagramRequestStatus();
      if (gate.limited) {
        const minutes = Math.max(1, Math.ceil(gate.retryAfterMs / 60000));
        const error = new Error(`O Instagram limitou as consultas. Aguarde aproximadamente ${minutes} minuto(s) antes de tentar novamente.`);
        error.code = "RATE_LIMITED";
        throw error;
      }
      if (!silent) {
        IA.setPanelStatus("Detectando sua conta do Instagram...");
      }

      const detected = await IA.detectCurrentInstagramAccount();
      const resolved = { userId: detected.userId, profileInfo: detected.profileInfo };

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

      // Detection failure must never clear snapshots or mutate saved identity.
      await showOfflineHistory().catch(() => {});
      if (!silent) {
        IA.setPanelStatus(
          `Não foi possível validar sua conta: ${error.message}. Histórico anterior preservado.`,
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
    let stage = "início";
    let watchdog = null;
    const markStage = (name) => {
      stage = name;
      console.info(`[Insta Analytics v5.6.11] ${name}`, new Date().toISOString());
    };
    // Never start a collection while a previously reported rate limit is active.
    const gate = await IA.getInstagramRequestStatus();
    if (gate.limited) {
      IA.setPanelStatus(`Instagram temporariamente limitado. Aguarde aproximadamente ${Math.max(1, Math.ceil(gate.retryAfterMs / 60000))} minuto(s). Seu histórico continua disponível.`, "warning");
      return;
    }

    IA.setCollecting(true);
    IA.setPanelProgress(null);
    // Diagnostic watchdog: never writes data, never interrupts an in-flight save.
    watchdog = setInterval(() => {
      console.warn(`[Insta Analytics v5.6.11] Ainda executando: ${stage}`);
    }, 30000);

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

      // Reuse the account already detected for this session. Do not add
      // an unnecessary profile request immediately before collection.
      const { userId, profileInfo } = detectedAccount;

      if (String(userId) !== String(detectedAccount.userId) || profileInfo.username !== username) {
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

      // Diagnóstico local: apenas métricas, sem nomes, IDs, tokens ou listas de pessoas.
      const diagnostic = {
        version: "5.6.10-safe-validation", timestamp: new Date().toISOString(),
        profileCounters: {
          followers: profileInfo?.followerCount ?? null,
          following: profileInfo?.followingCount ?? null
        },
        followers: followersResult?.meta ?? null,
        following: followingResult?.meta ?? null
      };
      window.__IA_LAST_COLLECTION_DIAGNOSTIC__ = diagnostic;
      console.info("[Insta Analytics DIAGNOSTICO] Resumo da coleta:", diagnostic);
      console.info("[Insta Analytics DIAGNOSTICO] JSON:", JSON.stringify(diagnostic, null, 2));

      markStage("criando snapshot");
      const snapshot = IA.createSnapshot({
        username,
        userId,
        profileInfo,
        followersResult,
        followingResult
      });

      markStage("carregando histórico local");
      const existing = IA.rebuildReliableHistory
        ? IA.rebuildReliableHistory(
            await IA.loadLocalSnapshots(username)
          )
        : await IA.loadLocalSnapshots(username);

      diagnostic.quality = snapshot?.quality ?? null;
      console.info("[Insta Analytics DIAGNOSTICO] Qualidade:", diagnostic.quality);

      const qualityStatus =
        snapshot?.quality?.status || "unknown";

      const comparisonEligible =
        snapshot?.quality?.comparisonEligible === true &&
        followersResult?.meta?.completed === true &&
        followingResult?.meta?.completed === true;

      // Proteção adicional: sem contadores, não transformar uma queda brusca
      // em unfollows. A referência histórica nunca é alterada nesta checagem.
      const previousEligible = existing.find(item =>
        item?.comparisonEligible === true && item?.username === snapshot.username &&
        Array.isArray(item.followers) && Array.isArray(item.following)
      );
      const abruptDrop = snapshot.quality?.verificationMethod === "end_of_pagination" &&
        previousEligible && ["followers", "following"].some(key => {
          const oldCount = previousEligible[key].length;
          const newCount = snapshot[key].length;
          return oldCount > 0 && oldCount - newCount > Math.max(10, Math.ceil(oldCount * 0.03));
        });
      if (abruptDrop) {
        snapshot.quality.status = "suspicious";
        snapshot.quality.comparisonEligible = false;
        snapshot.comparisonEligible = false;
        snapshot.quality.reason = "Queda superior ao limite de segurança sem contadores verificáveis. Histórico preservado.";
      }
      console.info("[Insta Analytics] validação", {
        status: snapshot.quality?.status,
        method: snapshot.quality?.verificationMethod || "profile_count",
        eligible: snapshot.quality?.comparisonEligible,
        abruptDrop: Boolean(abruptDrop),
        previousCounts: previousEligible ? {followers: previousEligible.followers.length, following: previousEligible.following.length} : null
      });

      if (
        qualityStatus === "suspicious" ||
        !comparisonEligible ||
        abruptDrop
      ) {
        await IA.setPanelData(snapshot, existing);
        IA.navigatePanel("overview");
        await IA.renderAuthPanel();

        const reason =
          snapshot?.quality?.reason ||
          "A coleta não passou na validação de integridade.";

        IA.setPanelStatus(
          `Coleta não salva: ${reason}`,
          "warning"
        );

        return;
      }

      markStage("calculando diferenças confiáveis");
      const reliable = IA.buildReliableDiff(
        snapshot,
        existing
      );

      markStage("anexando diferenças ao snapshot");
      IA.attachReliableSnapshotDiff(snapshot, reliable);

      markStage("gravando snapshot local (não interromper)");
      const savedRaw = await IA.saveLocalSnapshot(
        username,
        snapshot
      );

      markStage("snapshot local gravado; reconstruindo histórico");
      const saved = IA.rebuildReliableHistory
        ? IA.rebuildReliableHistory(savedRaw)
        : savedRaw;

      let usageMessage = "";

      try {
        markStage("registrando uso do plano");
        await Promise.race([IA.commitCollectionUse(access, snapshot), new Promise((_, reject) => setTimeout(() => reject(new Error("Tempo limite ao registrar uso")), 20000))]);
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
            markStage("sincronizando Supabase");
            await Promise.race([IA.syncSnapshotToSupabase(snapshot), new Promise((_, reject) => setTimeout(() => reject(new Error("Tempo limite na sincronização")), 25000))]);
            syncMessage = " · sincronizada no Supabase";
          }
        }
      } catch (syncError) {
        syncMessage =
          ` · salva localmente; sync falhou: ${syncError.message}`;
      }

      try {
        markStage("registrando notificações");
        await Promise.race([Promise.resolve(IA.recordNotificationsForSnapshot?.(snapshot)), new Promise((_, reject) => setTimeout(() => reject(new Error("Tempo limite nas notificações")), 15000))]);
      } catch (error) {
        console.warn(
          "[Insta Analytics] notifications:",
          error
        );
      }

      markStage("atualizando painel");
      await IA.setPanelData(saved[0], saved);
      IA.navigatePanel("overview");
      markStage("atualizando autenticação no painel");
      await Promise.race([IA.renderAuthPanel(), new Promise((_, reject) => setTimeout(() => reject(new Error("Tempo limite ao atualizar autenticação")), 15000))]);

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

      markStage("finalização concluída");
      IA.setPanelStatus(
        `Coleta concluída (${label})${diffMsg}${syncMessage}${usageMessage}.`,
        quality === "suspicious"
          ? "warning"
          : "success"
      );
    } catch (error) {
      console.error(`[Insta Analytics v5.6.11] Falha na etapa: ${stage}`, error);
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
      if (watchdog) clearInterval(watchdog);
      IA.setPanelProgress(null);
      IA.setCollecting(false);
    }
  };

  (async () => {
    // Never rewrite, trim or migrate historical snapshots on panel startup.

    await showOfflineHistory().catch(() => {});
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
