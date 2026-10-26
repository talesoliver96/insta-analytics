window.InstaAnalytics = window.InstaAnalytics || {};
(() => {
  const APP_ID = "936619743392459";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const RATE_LIMIT_KEY = "ia_instagram_rate_limit_until_v1";
  let rateLimitUntil = 0;
  let lastRequestAt = 0;
  let queue = Promise.resolve();
  let detectionInFlight = null;
  async function respectRateLimit() {
    const stored = await chrome.storage.local.get(RATE_LIMIT_KEY);
    rateLimitUntil = Math.max(rateLimitUntil, Number(stored[RATE_LIMIT_KEY] || 0));
    if (Date.now() < rateLimitUntil) {
      throw makeInstagramError("O Instagram limitou as consultas. Aguarde antes de tentar novamente.", "RATE_LIMITED", { retryAfterMs: rateLimitUntil - Date.now() });
    }
  }
  async function serializedFetch(url, options) {
    const task = queue.catch(() => {}).then(async () => {
      await respectRateLimit();
      const delay = Math.max(0, 2200 - (Date.now() - lastRequestAt));
      if (delay) await sleep(delay);
      await respectRateLimit();
      lastRequestAt = Date.now();
      return fetch(url, options);
    });
    queue = task.catch(() => {});
    return task;
  }

  function makeInstagramError(message, code, extra = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, extra);
    return error;
  }

  async function requestJson(url, label = "request") {
    let lastError;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await serializedFetch(url, {
          credentials: "include",
          headers: {
            accept: "application/json",
            "x-ig-app-id": APP_ID,
            "x-requested-with": "XMLHttpRequest"
          }
        });

        const contentType = response.headers.get("content-type") || "";
        const text = await response.text();

        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = { raw: text };
        }

        if (response.status === 429) {
          const retryAfter = response.headers.get("retry-after");
          const seconds = /^\d+$/.test(retryAfter || "") ? Number(retryAfter) : null;
          const parsedDate = retryAfter && seconds === null ? Date.parse(retryAfter) : NaN;
          const duration = seconds !== null ? seconds * 1000 : Number.isFinite(parsedDate) ? parsedDate - Date.now() : 60 * 60 * 1000;
          rateLimitUntil = Date.now() + Math.max(60 * 1000, Math.min(duration, 24 * 60 * 60 * 1000));
          await chrome.storage.local.set({ [RATE_LIMIT_KEY]: rateLimitUntil });
          throw makeInstagramError(
            "O Instagram limitou temporariamente as requisições.",
            "RATE_LIMITED",
            { httpStatus: 429 }
          );
        }

        if (response.status === 401 || response.status === 403) {
          throw makeInstagramError(
            "A sessão do Instagram não autorizou esta consulta.",
            "INSTAGRAM_AUTH",
            { httpStatus: response.status }
          );
        }

        if (data?.spam === true) {
          throw makeInstagramError(
            "O Instagram limitou temporariamente a leitura desta lista.",
            "INSTAGRAM_TEMPORARILY_BLOCKED",
            {
              httpStatus: response.status,
              instagramStatus: data?.status || "",
              instagramMessage: data?.message || ""
            }
          );
        }

        const trimmed = String(text || "").trimStart();
        const returnedHtml =
          contentType.toLowerCase().includes("text/html") ||
          trimmed.startsWith("<!DOCTYPE") ||
          trimmed.startsWith("<html");

        const redirectedToHome =
          response.redirected &&
          /^https:\/\/www\.instagram\.com\/?$/i.test(response.url || "");

        if (returnedHtml || redirectedToHome) {
          throw makeInstagramError(
            "O Instagram não disponibilizou esta lista nesta tentativa.",
            "INSTAGRAM_TEMPORARILY_BLOCKED",
            {
              httpStatus: response.status,
              redirected: response.redirected,
              responseUrl: response.url || ""
            }
          );
        }

        if (!response.ok) {
          const error = new Error(
            data?.message ||
            data?.error_type ||
            `HTTP ${response.status}`
          );
          error.httpStatus = response.status;
          throw error;
        }

        return data;
      } catch (error) {
        lastError = error;

        if ([
          "RATE_LIMITED",
          "INSTAGRAM_AUTH",
          "INSTAGRAM_TEMPORARILY_BLOCKED"
        ].includes(error.code)) {
          throw error;
        }

        if (error.httpStatus === 404 || (error.httpStatus >= 400 && error.httpStatus < 500)) throw error;
        if (attempt < 2) {
          await sleep(
            2000 * (attempt + 1) +
            Math.floor(Math.random() * 800)
          );
        }
      }
    }

    throw new Error(
      `${label} falhou: ${lastError?.message || "erro desconhecido"}`
    );
  }

  async function detectCurrentInstagramAccountImpl() {
    const data = await requestJson(
      "https://www.instagram.com/api/v1/accounts/edit/web_form_data/",
      "detecção da conta atual"
    );

    const raw = data?.form_data || data?.user || data || {};
    const username =
      window.InstaAnalytics.normalizeAccountKey?.(raw.username || "") || "";

    if (!username) {
      const error = new Error(
        "Não foi possível identificar a conta logada no Instagram."
      );
      error.code = "INSTAGRAM_ACCOUNT_NOT_DETECTED";
      throw error;
    }

    let userId = String(raw.pk || raw.id || raw.user_id || "");

    let profileInfo = {
      username,
      fullName: raw.first_name || raw.full_name || raw.name || "",
      profilePic: raw.profile_pic_url || raw.profile_pic_url_hd || "",
      isPrivate: !!raw.is_private,
      isVerified: !!raw.is_verified,
      followerCount: raw.follower_count == null ? null : Number(raw.follower_count),
      followingCount: raw.following_count == null ? null : Number(raw.following_count)
    };

    if (!userId) {
      // Only use an ID previously validated and saved for this same username.
      // No additional profile lookup: that endpoint can independently return 429.
      const cached = await window.InstaAnalytics.loadLocalAccount?.(username);
      if (cached?.userId && cached.username === username) {
        userId = String(cached.userId);
        profileInfo = { ...cached, ...profileInfo, username };
      }
    }

    if (!userId) {
      // The authenticated edit endpoint sometimes omits pk/id on new accounts.
      // Resolve ONLY the username returned by that authenticated endpoint;
      // never infer the identity from the page being viewed.
      try {
        const resolved = await window.InstaAnalytics.resolveProfile(username);
        if (resolved?.userId && resolved?.profileInfo?.username === username) {
          userId = String(resolved.userId);
          profileInfo = {
            ...resolved.profileInfo,
            ...Object.fromEntries(Object.entries(profileInfo).filter(([key, value]) =>
              value !== null && value !== undefined && value !== ""
            )),
            username
          };
          console.info("[Insta Analytics] ID da conta obtido por consulta complementar do perfil autenticado.");
        }
      } catch (error) {
        if (["RATE_LIMITED", "INSTAGRAM_AUTH", "INSTAGRAM_TEMPORARILY_BLOCKED"].includes(error.code) || error.httpStatus === 429) {
          throw error;
        }
        console.warn("[Insta Analytics] Consulta complementar indisponível:", error.code || error.httpStatus || "erro");
      }
    }

    if (!userId) {
      const error = new Error(
        "O Instagram identificou @" + username + ", mas não disponibilizou o ID da conta. Aguarde e tente Atualizar usuário novamente."
      );
      error.code = "INSTAGRAM_ACCOUNT_NOT_DETECTED";
      throw error;
    }

    return { userId, username, ...profileInfo, profileInfo };
  }

  // Coalesce overlapping refresh/collect detection into one authenticated request.
  async function detectCurrentInstagramAccount() {
    if (detectionInFlight) return detectionInFlight;
    detectionInFlight = detectCurrentInstagramAccountImpl();
    try { return await detectionInFlight; }
    finally { detectionInFlight = null; }
  }

  async function getInstagramRequestStatus() {
    const stored = await chrome.storage.local.get(RATE_LIMIT_KEY);
    const until = Math.max(rateLimitUntil, Number(stored[RATE_LIMIT_KEY] || 0));
    return { limited: until > Date.now(), retryAfterMs: Math.max(0, until - Date.now()), until };
  }

  Object.assign(window.InstaAnalytics, {
    getInstagramRequestStatus,
    requestJson,
    sleep,
    detectCurrentInstagramAccount
  });
})();
