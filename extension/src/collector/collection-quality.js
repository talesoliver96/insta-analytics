window.InstaAnalytics = window.InstaAnalytics || {};
(() => {
  // Pequenas diferenças de 1-3 contas podem ocorrer durante a paginação e são
  // tratadas pelo Reliable Diffs. Quedas grandes nunca podem virar baseline.
  const MIN_RATIO = 0.995;
  const MISSING_TOLERANCE = 3;

  function evaluateQuality({ expectedFollowers, expectedFollowing, followers, following, followersMeta, followingMeta }) {
    const actualFollowers = Array.isArray(followers) ? followers.length : 0;
    const actualFollowing = Array.isArray(following) ? following.length : 0;
    const knownFollowers = Number.isFinite(Number(expectedFollowers)) && Number(expectedFollowers) >= 0;
    const knownFollowing = Number.isFinite(Number(expectedFollowing)) && Number(expectedFollowing) >= 0;

    const expFollowers = knownFollowers ? Number(expectedFollowers) : null;
    const expFollowing = knownFollowing ? Number(expectedFollowing) : null;

    if (!knownFollowers || !knownFollowing) {
      const paginationCompleted = followersMeta?.completed === true && followingMeta?.completed === true;
      return {
        status: paginationCompleted ? "unverified" : "unknown",
        comparisonEligible: paginationCompleted,
        actualFollowers,
        actualFollowing,
        expectedFollowers: expFollowers,
        expectedFollowing: expFollowing,
        followersMeta: followersMeta || null,
        followingMeta: followingMeta || null,
        reason: paginationCompleted
          ? "Paginação finalizada, mas o Instagram não informou contadores confiáveis."
          : "Não foi possível validar a integridade da coleta."
      };
    }

    const followersRatio = expFollowers > 0 ? actualFollowers / expFollowers : 1;
    const followingRatio = expFollowing > 0 ? actualFollowing / expFollowing : 1;
    const followersMissing = Math.max(0, expFollowers - actualFollowers);
    const followingMissing = Math.max(0, expFollowing - actualFollowing);

    const followersSuspicious =
      followersMissing > MISSING_TOLERANCE &&
      followersRatio < MIN_RATIO;
    const followingSuspicious =
      followingMissing > MISSING_TOLERANCE &&
      followingRatio < MIN_RATIO;

    // Mesmo que a razão pareça boa, um coletor que explicitamente terminou
    // "short_of_expected" não pode ser baseline de comparação.
    const collectorShort =
      followersMeta?.stopReason === "short_of_expected_after_retries" ||
      followingMeta?.stopReason === "short_of_expected_after_retries";

    const suspicious = followersSuspicious || followingSuspicious || collectorShort;

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
        : "Coleta validada pelos contadores do perfil."
    };
  }

  window.InstaAnalytics.evaluateQuality = evaluateQuality;
})();
