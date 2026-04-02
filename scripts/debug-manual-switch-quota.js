"use strict";

const { createConfig } = require("../src/runtime-config");
const { loadAccountsFile, findStoredAccountAuthPayload } = require("../src/accounts-file");
const { refreshAuthPayloadViaUpstream } = require("../src/gateway-auth");
const { __private__ } = require("../src/routes/admin");

function parseArgs(argv) {
  const args = { account: "", all: false };

  for (let i = 0; i < argv.length; i += 1) {
    const value = String(argv[i] || "");
    if (value === "--all") {
      args.all = true;
      continue;
    }
    if (value === "--account") {
      args.account = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
  }

  return args;
}

function summarizeAccount(account) {
  return {
    id: account && account.id ? String(account.id) : null,
    name: account && account.name ? String(account.name) : null,
    accountId: account && account.accountId ? String(account.accountId) : null,
    source: account && account.source ? String(account.source) : null
  };
}

async function probeAccount(config, account) {
  const alias = account && account.id ? String(account.id) : "";
  const storedAuthPayload = findStoredAccountAuthPayload(config.accountsPath, {
    alias,
    accountId: account && account.accountId ? String(account.accountId) : "",
    userId: account && account.user && account.user.id ? String(account.user.id) : "",
    name: account && account.name ? String(account.name) : ""
  });

  if (!storedAuthPayload) {
    return {
      ...summarizeAccount(account),
      ok: false,
      phase: "load_auth_payload",
      error: "missing stored auth payload"
    };
  }

  let refreshedAuthPayload;
  try {
    refreshedAuthPayload = await refreshAuthPayloadViaUpstream(config, storedAuthPayload, {
      alias,
      accountId: alias,
      expectedUserId: storedAuthPayload && storedAuthPayload.user && storedAuthPayload.user.id
        ? String(storedAuthPayload.user.id)
        : null
    });
  } catch (error) {
    return {
      ...summarizeAccount(account),
      ok: false,
      phase: "refresh_auth_payload",
      error: error && error.message ? error.message : String(error)
    };
  }

  let quota;
  try {
    quota = await __private__.requestQuotaViaUpstream(config, {
      ...storedAuthPayload,
      ...refreshedAuthPayload,
      user: storedAuthPayload.user || null,
      source: "bridge-direct-login"
    });
  } catch (error) {
    return {
      ...summarizeAccount(account),
      ok: false,
      phase: "request_quota",
      refreshBoundUserId: refreshedAuthPayload && refreshedAuthPayload.refreshBoundUserId
        ? String(refreshedAuthPayload.refreshBoundUserId)
        : null,
      error: error && error.message ? error.message : String(error)
    };
  }

  return {
    ...summarizeAccount(account),
    ok: true,
    refreshBoundUserId: refreshedAuthPayload && refreshedAuthPayload.refreshBoundUserId
      ? String(refreshedAuthPayload.refreshBoundUserId)
      : null,
    usagePercent: Number(quota && quota.usagePercent),
    refreshCountdownSeconds: Number(quota && quota.refreshCountdownSeconds),
    checkedAt: quota && quota.checkedAt ? String(quota.checkedAt) : null,
    available: Number.isFinite(Number(quota && quota.usagePercent))
      ? Number(quota.usagePercent) < 100
      : null
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = createConfig(process.env);
  const state = loadAccountsFile(config.accountsPath);
  const accounts = Array.isArray(state.accounts) ? state.accounts : [];

  const selectedAccounts = args.account
    ? accounts.filter((account) => {
        const values = new Set([
          account && account.id ? String(account.id) : "",
          account && account.accountId ? String(account.accountId) : "",
          account && account.name ? String(account.name) : "",
          account && account.user && account.user.id ? String(account.user.id) : ""
        ].filter(Boolean));
        return values.has(args.account);
      })
    : (args.all ? accounts : accounts.filter((account) => String(account && account.id || "") === String(state.activeAccount || "")));

  if (selectedAccounts.length === 0) {
    throw new Error(args.account
      ? `No account matched ${args.account}`
      : "No account selected");
  }

  const results = [];
  for (const account of selectedAccounts) {
    results.push(await probeAccount(config, account));
  }

  console.log(JSON.stringify({
    activeAccount: state.activeAccount || null,
    selectedCount: selectedAccounts.length,
    results
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
