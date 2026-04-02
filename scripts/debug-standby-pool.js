"use strict";

const { createConfig } = require("../src/runtime-config");
const { AuthProvider } = require("../src/auth-provider");
const { DirectLlmClient } = require("../src/direct-llm");

function formatTs(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toISOString();
}

function formatRemaining(untilMs) {
  if (!Number.isFinite(untilMs) || untilMs <= Date.now()) {
    return "0s";
  }

  const totalSeconds = Math.ceil((untilMs - Date.now()) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}

function mapAccountToCredential(account) {
  return {
    accountId: account.id,
    accountName: account.name,
    token: account.accessToken,
    refreshToken: account.refreshToken || null,
    cookie: account.cookie || null,
    user: account.user || null,
    expiresAt: account.expiresAt || null,
    expiresAtRaw: account.expiresAtRaw || null,
    source: account.source,
    transportOverride: account.transportOverride || null,
    baseUrl: account.baseUrl || null
  };
}

async function simulateStandbyPass({ authProvider, directClient }) {
  const now = Date.now();
  const currentServingAccountId = typeof directClient._getCurrentServingAccountId === "function"
    ? directClient._getCurrentServingAccountId()
    : "";
  const preferredActiveAccountId = typeof directClient._getPreferredActiveAccountId === "function"
    ? directClient._getPreferredActiveAccountId()
    : "";
  const excludedAccountIds = new Set(
    [currentServingAccountId, preferredActiveAccountId].filter(Boolean).map(String)
  );

  const configuredAccounts = authProvider.getConfiguredAccounts();
  const inspection = [];
  const ready = [];
  const cooldown = [];

  for (const account of configuredAccounts) {
    const item = {
      accountId: account && account.id ? String(account.id) : null,
      accountName: account && account.name ? String(account.name) : null,
      source: account && account.source ? String(account.source) : null
    };

    if (!account || !account.id) {
      inspection.push({ ...item, state: "skipped", reason: "missing id" });
      continue;
    }

    if (account.source === "gateway") {
      inspection.push({ ...item, state: "skipped", reason: "gateway source excluded" });
      continue;
    }

    if (excludedAccountIds.has(String(account.id))) {
      inspection.push({ ...item, state: "skipped", reason: "active/current account excluded" });
      continue;
    }

    if (!account.enabled) {
      inspection.push({ ...item, state: "skipped", reason: "disabled" });
      continue;
    }

    if (!account.accessToken) {
      inspection.push({ ...item, state: "skipped", reason: "missing access token" });
      continue;
    }

    if (account.expiresAt && Number(account.expiresAt) <= now) {
      inspection.push({ ...item, state: "skipped", reason: "expired token" });
      continue;
    }

    const invalidUntil = typeof authProvider.getInvalidUntil === "function"
      ? Number(authProvider.getInvalidUntil(account.id) || 0)
      : 0;
    const lastFailure = typeof authProvider.getLastFailure === "function"
      ? authProvider.getLastFailure(account.id)
      : null;

    if (invalidUntil > now) {
      const result = {
        ...item,
        state: "cooldown",
        reason: lastFailure && lastFailure.reason ? lastFailure.reason : "account cooling down",
        invalidUntil: new Date(invalidUntil).toISOString(),
        remaining: formatRemaining(invalidUntil)
      };
      inspection.push(result);
      cooldown.push(result);
      continue;
    }

    const credential = mapAccountToCredential(account);

    try {
      const quota = await directClient.fetchQuotaStatus(credential);
      const usagePercent = Number(quota && quota.usagePercent);
      const refreshCountdownSeconds = Number(quota && quota.refreshCountdownSeconds);

      if (Number.isFinite(usagePercent) && usagePercent >= 100) {
        const refreshUntilMs = typeof directClient._getQuotaRefreshUntilMs === "function"
          ? directClient._getQuotaRefreshUntilMs(quota)
          : 0;
        const result = {
          ...item,
          state: "cooldown",
          reason: `quota precheck skipped account at ${Math.round(usagePercent)}%`,
          usagePercent,
          refreshCountdownSeconds: Number.isFinite(refreshCountdownSeconds) ? refreshCountdownSeconds : null,
          invalidUntil: refreshUntilMs ? new Date(refreshUntilMs).toISOString() : null,
          remaining: refreshUntilMs ? formatRemaining(refreshUntilMs) : null
        };
        inspection.push(result);
        cooldown.push(result);
        continue;
      }

      const result = {
        ...item,
        state: "ready",
        usagePercent: Number.isFinite(usagePercent) ? usagePercent : null,
        refreshCountdownSeconds: Number.isFinite(refreshCountdownSeconds) ? refreshCountdownSeconds : null,
        checkedAt: formatTs(quota && quota.checkedAt)
      };
      inspection.push(result);
      ready.push(result);
    } catch (error) {
      const result = {
        ...item,
        state: "rechecking",
        reason: error && error.message ? error.message : String(error)
      };
      inspection.push(result);
      cooldown.push(result);
    }
  }

  return {
    excludedAccountIds: [...excludedAccountIds],
    ready,
    cooldown,
    inspection
  };
}

async function rawProbeAllAccounts({ authProvider, directClient }) {
  const results = [];

  for (const account of authProvider.getConfiguredAccounts()) {
    if (!account || !account.id || account.source === "gateway" || !account.enabled || !account.accessToken) {
      continue;
    }

    const credential = mapAccountToCredential(account);

    try {
      const quota = await directClient.fetchQuotaStatus(credential);
      const usagePercent = Number(quota && quota.usagePercent);
      results.push({
        accountId: credential.accountId,
        accountName: credential.accountName,
        source: credential.source,
        available: Number.isFinite(usagePercent) ? usagePercent < 100 : null,
        usagePercent: Number.isFinite(usagePercent) ? usagePercent : null,
        refreshCountdownSeconds: Number(quota && quota.refreshCountdownSeconds) || null,
        checkedAt: formatTs(quota && quota.checkedAt)
      });
    } catch (error) {
      results.push({
        accountId: credential.accountId,
        accountName: credential.accountName,
        source: credential.source,
        available: null,
        error: error && error.message ? error.message : String(error)
      });
    }
  }

  return results;
}

async function main() {
  const config = createConfig(process.env);
  const authProvider = new AuthProvider(config);
  const directClient = new DirectLlmClient({
    ...config,
    upstreamBaseUrl: config.directLlmBaseUrl,
    authProvider
  });

  const summary = authProvider.getSummary();
  const standbySimulation = await simulateStandbyPass({ authProvider, directClient });
  const rawProbe = await rawProbeAllAccounts({ authProvider, directClient });

  console.log(JSON.stringify({
    config: {
      authMode: config.authMode,
      standbyEnabled: config.accountStandbyEnabled,
      standbyRefreshMs: config.accountStandbyRefreshMs,
      quotaPreflightEnabled: config.quotaPreflightEnabled,
      directLlmBaseUrl: config.directLlmBaseUrl,
      upstreamBaseUrl: config.directLlmBaseUrl
    },
    authSummary: {
      activeAccount: summary.activeAccount || null,
      usableAccountIds: summary.activeExternalAccounts || [],
      invalidAccountIds: Object.keys(summary.invalidAccounts || {})
    },
    standbySimulation,
    rawProbe
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
