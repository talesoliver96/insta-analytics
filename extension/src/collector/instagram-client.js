window.InstaAnalytics = window.InstaAnalytics || {};
(() => {
  const APP_ID = "936619743392459";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
        const response = await fetch(url, {
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

  async function detectCurrentInstagramAccount() {
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
      followerCount: Number(raw.follower_count || 0),
      followingCount: Number(raw.following_count || 0)
    };

    if (!userId && window.InstaAnalytics.resolveProfile) {
      const resolved = await window.InstaAnalytics.resolveProfile(username);
      userId = String(resolved.userId || "");
      profileInfo = { ...resolved.profileInfo, ...profileInfo, username };
    }

    if (!userId) {
      const error = new Error(
        "Não foi possível obter o ID da conta logada no Instagram."
      );
      error.code = "INSTAGRAM_ACCOUNT_NOT_DETECTED";
      throw error;
    }

    return { userId, username, ...profileInfo, profileInfo };
  }

  Object.assign(window.InstaAnalytics, {
    requestJson,
    sleep,
    detectCurrentInstagramAccount
  });
})();
