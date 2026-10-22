window.InstaAnalytics = window.InstaAnalytics || {};
(() => {
  // Pequenas diferenças de 1-3 contas podem ocorrer durante a paginação e são
  // tratadas pelo Reliable Diffs. Quedas grandes nunca podem virar baseline.
  const MIN_RATIO = 0.995;
  const MISSING_TOLERANCE = 3;

  function evaluateQuality({ expectedFollowers, expectedFollowing, followers, following, followersMeta, followingMeta }) {
    const actualFollowers = Array.isArray(followers) ? followers.length : 0;
    const actualFollowing = Array.isArray(following) ? following.length : 0;
    const knownFollowers = expectedFollowers !== null && expectedFollowers !== undefined && expectedFollowers !== "" && Number.isFinite(Number(expectedFollowers)) && Number(expectedFollowers) >= 0;
    const knownFollowing = expectedFollowing !== null && expectedFollowing !== undefined && expectedFollowing !== "" && Number.isFinite(Number(expectedFollowing)) && Number(expectedFollowing) >= 0;

    const expFollowers = knownFollowers ? Number(expectedFollowers) : null;
    const expFollowing = knownFollowing ? Number(expectedFollowing) : null;

    if (!knownFollowers || !knownFollowing) {
      const metas = [followersMeta, followingMeta];
      const complete = metas.every(m => m?.completed === true && m?.stopReason === "end_of_pagination" && Number(m?.pages) > 0);
      const integrity = metas.every(m => Number(m?.invalidTotal ?? 0) === 0 &&
        Number(m?.collected) >= 0 &&
        Number(m?.receivedTotal) >= Number(m?.collected) &&
        Array.isArray(m?.pageStats) && m.pageStats.length === m.pages &&
        m.pageStats.at(-1)?.hasNext === false);
      const credible = complete && integrity && actualFollowers > 0 && actualFollowing > 0 &&
        followersMeta.collected === actualFollowers && followingMeta.collected === actualFollowing;
      return {
        status: credible ? "unverified" : "unknown",
        comparisonEligible: credible,
        verificationMethod: credible ? "end_of_pagination" : "none",
        actualFollowers, actualFollowing,
        expectedFollowers: expFollowers, expectedFollowing: expFollowing,
        followersMeta: followersMeta || null, followingMeta: followingMeta || null,
        reason: credible
          ? "Paginação concluída e consistente; contadores externos indisponíveis. Comparações ainda exigem confirmação."
          : "Coleta sem contadores não passou nas verificações de paginação e integridade."
      };
    }

    const followersRatio = expFollowers > 0 ? actualFollowers / expFollowers : 1;
    const followingRatio = expFollowing > 0 ? actualFollowing / expFollowing : 1;
    const followersMissing = Math.max(0, expFollowers - actualFollowers);
    const followingMissing = Math.max(0, expFollowing - actualFollowing);

    const followersSuspicious =
      (expFollowers === 0 && actualFollowers > 0) ||
      (expFollowers > 0 && actualFollowers > expFollowers + MISSING_TOLERANCE) ||
      followersMissing > MISSING_TOLERANCE &&
      followersRatio < MIN_RATIO;
    const followingSuspicious =
      (expFollowing === 0 && actualFollowing > 0) ||
      (expFollowing > 0 && actualFollowing > expFollowing + MISSING_TOLERANCE) ||
      followingMissing > MISSING_TOLERANCE &&
      followingRatio < MIN_RATIO;

    // Mesmo que a razão pareça boa, um coletor que explicitamente terminou
    // "short_of_expected" não pode ser baseline de comparação.
    const collectorShort =
      followersMeta?.stopReason === "short_of_expected_after_retries" ||
      followingMeta?.stopReason === "short_of_expected_after_retries";

    const suspicious = followersSuspicious || followingSuspicious || collectorShort ||
      followersMeta?.completed !== true || followingMeta?.completed !== true ||
      actualFollowers === 0 && expFollowers > 0 ||
      actualFollowing === 0 && expFollowing > 0;

    return {
      status: suspicious ? "suspicious" : "valid",
      comparisonEligible: !suspicious,
      expectedFollowers: expFollowers,
      expectedFollowing: expFollowing,
      actualFollowers,
      actualFollowing,
      followersRatio,
      followingRatio,
      followersMissing,
      followingMissing,
      followersMeta: followersMeta || null,
      followingMeta: followingMeta || null,
      reason: suspicious
        ? `Coleta incompleta: seguidores ${actualFollowers}/${expFollowers}, seguindo ${actualFollowing}/${expFollowing}. Esta coleta não será usada para confirmar mudanças.`
        : "Coleta concluída e consistente com os contadores do perfil."
    };
  }

  window.InstaAnalytics.evaluateQuality = evaluateQuality;
})();
