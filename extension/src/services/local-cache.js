window.InstaAnalytics = window.InstaAnalytics || {};
(() => {
  const IA = window.InstaAnalytics;

  const SNAPSHOT_KEY = "ia_snapshots_v2";
  const ACCOUNT_KEY = "ia_accounts_v1";
  const STORE_VERSION = 3;
  const CODEC = "gzip-base64";

  function normalizeAccountKey(username) {
    return IA.normalizeAccountKey(username);
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;

    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }

    return btoa(binary);
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
  }

  async function gzipText(text) {
    if (typeof CompressionStream !== "function") {
      throw new Error("CompressionStream indisponível neste Chrome.");
    }

    const stream = new Blob([text])
      .stream()
      .pipeThrough(new CompressionStream("gzip"));

    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function gunzipText(bytes) {
    if (typeof DecompressionStream !== "function") {
      throw new Error("DecompressionStream indisponível neste Chrome.");
    }

    const stream = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));

    return await new Response(stream).text();
  }

  async function encodeSnapshot(snapshot) {
    const json = JSON.stringify(snapshot);
    const compressed = await gzipText(json);

    return {
      id: String(snapshot?.id || ""),
      createdAt: Number(snapshot?.createdAt || Date.now()),
      codec: CODEC,
      data: bytesToBase64(compressed)
    };
  }

  async function decodeSnapshot(record) {
    if (!record) return null;

    if (!record.data || record.codec !== CODEC) {
      return record;
    }

    const json = await gunzipText(base64ToBytes(record.data));
    return JSON.parse(json);
  }

  function isCompressedStore(value) {
    return (
      value &&
      value.version === STORE_VERSION &&
      value.codec === CODEC &&
      value.accounts &&
      typeof value.accounts === "object"
    );
  }

  async function encodeLegacyStore(legacy) {
    const limit = Number(IA.config?.LOCAL_SNAPSHOT_LIMIT || 30);
    const accounts = {};

    for (const [username, snapshots] of Object.entries(legacy || {})) {
      if (!Array.isArray(snapshots)) continue;

      const normalized = normalizeAccountKey(username);
      if (!normalized) continue;

      const ordered = [...snapshots]
        .filter(Boolean)
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
        .slice(0, limit);

      accounts[normalized] = [];

      for (const snapshot of ordered) {
        accounts[normalized].push(await encodeSnapshot(snapshot));
      }
    }

    return {
      version: STORE_VERSION,
      codec: CODEC,
      accounts
    };
  }

  async function writeCompressedStore(store, { allowDestructiveRetry = true } = {}) {
    try {
      await chrome.storage.local.set({ [SNAPSHOT_KEY]: store });
      return;
    } catch (error) {
      const quotaError = /quota|QUOTA_BYTES|kQuotaBytes/i.test(
        String(error?.message || error)
      );

      if (!quotaError || !allowDestructiveRetry) {
        throw error;
      }

      // O store comprimido já está em memória. Remove somente a chave antiga
      // e grava imediatamente a versão comprimida.
      await chrome.storage.local.remove(SNAPSHOT_KEY);

      try {
        await chrome.storage.local.set({ [SNAPSHOT_KEY]: store });
      } catch (retryError) {
        // Último fallback: mantém os 20 snapshots mais recentes por conta.
        const reduced = {
          version: STORE_VERSION,
          codec: CODEC,
          accounts: {}
        };

        for (const [username, records] of Object.entries(store.accounts || {})) {
          reduced.accounts[username] = (records || []).slice(0, 20);
        }

        await chrome.storage.local.set({ [SNAPSHOT_KEY]: reduced });
      }
    }
  }

  async function ensureCompressedStore() {
    const data = await chrome.storage.local.get(SNAPSHOT_KEY);
    const current = data[SNAPSHOT_KEY];

    if (!current) {
      return {
        version: STORE_VERSION,
        codec: CODEC,
        accounts: {}
      };
    }

    if (isCompressedStore(current)) {
      return current;
    }

    const migrated = await encodeLegacyStore(current);
    await writeCompressedStore(migrated);

    return migrated;
  }

  async function loadSnapshots(username) {
    const key = normalizeAccountKey(username);
    if (!key) return [];

    const store = await ensureCompressedStore();
    const records = store.accounts?.[key] || [];
    const snapshots = [];

    for (const record of records) {
      try {
        const decoded = await decodeSnapshot(record);
        if (decoded) snapshots.push(decoded);
      } catch (error) {
        console.warn(
          "[Insta Analytics] snapshot local corrompido ignorado:",
          error
        );
      }
    }

    return snapshots.sort(
      (a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)
    );
  }

  async function saveSnapshot(username, snapshot) {
    const key = normalizeAccountKey(username);
    if (!key) {
      throw new Error("Usuário inválido para salvar snapshot.");
    }

    const store = await ensureCompressedStore();
    const limit = Number(IA.config?.LOCAL_SNAPSHOT_LIMIT || 30);
    const encoded = await encodeSnapshot(snapshot);

    const current = Array.isArray(store.accounts?.[key])
      ? store.accounts[key]
      : [];

    store.accounts[key] = [
      encoded,
      ...current.filter(
        (item) => String(item?.id || "") !== String(snapshot.id)
      )
    ]
      .sort(
        (a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)
      )
      .slice(0, limit);

    await writeCompressedStore(store);

    return await loadSnapshots(key);
  }

  async function optimizeSnapshotStorage() {
    const before = await chrome.storage.local.getBytesInUse(null);
    const store = await ensureCompressedStore();
    const limit = Number(IA.config?.LOCAL_SNAPSHOT_LIMIT || 30);

    for (const key of Object.keys(store.accounts || {})) {
      const seen = new Set();

      store.accounts[key] = (store.accounts[key] || [])
        .sort(
          (a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)
        )
        .filter((record) => {
          const id = String(record?.id || "");
          if (!id || seen.has(id)) return false;
          seen.add(id);
          return true;
        })
        .slice(0, limit);
    }

    await writeCompressedStore(store);

    await chrome.storage.local.remove([
      "ia_collection_diagnostics_v543"
    ]);

    const after = await chrome.storage.local.getBytesInUse(null);

    return {
      beforeBytes: before,
      afterBytes: after,
      savedBytes: Math.max(0, before - after),
      version: STORE_VERSION,
      codec: CODEC
    };
  }

  async function getLocalStorageStats() {
    const totalBytes = await chrome.storage.local.getBytesInUse(null);
    const snapshotBytes = await chrome.storage.local.getBytesInUse(SNAPSHOT_KEY);
    const store = await ensureCompressedStore();

    const accounts = Object.fromEntries(
      Object.entries(store.accounts || {}).map(([key, rows]) => [
        key,
        Array.isArray(rows) ? rows.length : 0
      ])
    );

    return {
      totalBytes,
      snapshotBytes,
      accounts,
      storeVersion: STORE_VERSION,
      codec: CODEC
    };
  }

  async function saveAccount(profileInfo, userId) {
    const username = normalizeAccountKey(profileInfo?.username);
    if (!username) return;

    const data = await chrome.storage.local.get(ACCOUNT_KEY);
    const all = data[ACCOUNT_KEY] || {};

    all[username] = {
      userId: String(userId || ""),
      username,
      fullName: profileInfo?.fullName || "",
      profilePic: profileInfo?.profilePic || "",
      isPrivate: !!profileInfo?.isPrivate,
      isVerified: !!profileInfo?.isVerified,
      updatedAt: Date.now()
    };

    await chrome.storage.local.set({ [ACCOUNT_KEY]: all });
  }

  async function loadAccount(username) {
    const key = normalizeAccountKey(username);
    const data = await chrome.storage.local.get(ACCOUNT_KEY);
    return data[ACCOUNT_KEY]?.[key] || null;
  }

  Object.assign(IA, {
    loadLocalSnapshots: loadSnapshots,
    saveLocalSnapshot: saveSnapshot,
    saveLocalAccount: saveAccount,
    loadLocalAccount: loadAccount,
    optimizeLocalSnapshotStorage: optimizeSnapshotStorage,
    getLocalStorageStats
  });
})();
