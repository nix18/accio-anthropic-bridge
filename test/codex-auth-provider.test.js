"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { CodexAuthProvider } = require("../src/codex-auth-provider");

test("CodexAuthProvider loads file accounts and rotates round robin", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "accio-codex-auth-provider-"));
  const filePath = path.join(tempDir, "codex-accounts.json");
  const statePath = path.join(tempDir, "codex-auth-provider-state.json");

  fs.writeFileSync(
    filePath,
    JSON.stringify({
      strategy: "round_robin",
      accounts: [
        { id: "codex_a", credentialBundle: { headers: { authorization: "Bearer a" } }, enabled: true },
        { id: "codex_b", credentialBundle: { headers: { authorization: "Bearer b" } }, enabled: true }
      ]
    })
  );

  const provider = new CodexAuthProvider({ codexAccountsPath: filePath, codexAuthStatePath: statePath });
  assert.equal(provider.resolveCredential().accountId, "codex_a");
  assert.equal(provider.resolveCredential().accountId, "codex_b");
});

test("CodexAuthProvider respects activeAccount", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "accio-codex-auth-provider-"));
  const filePath = path.join(tempDir, "codex-accounts.json");
  const statePath = path.join(tempDir, "codex-auth-provider-state.json");

  fs.writeFileSync(
    filePath,
    JSON.stringify({
      strategy: "round_robin",
      activeAccount: "codex_b",
      accounts: [
        { id: "codex_a", credentialBundle: { headers: { authorization: "Bearer a" } }, enabled: true, priority: 2 },
        { id: "codex_b", credentialBundle: { headers: { authorization: "Bearer b" } }, enabled: true, priority: 1 }
      ]
    })
  );

  const provider = new CodexAuthProvider({ codexAccountsPath: filePath, codexAuthStatePath: statePath });
  assert.equal(provider.resolveCredential().accountId, "codex_b");
});

test("CodexAuthProvider invalidates accounts temporarily", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "accio-codex-auth-provider-"));
  const filePath = path.join(tempDir, "codex-accounts.json");
  const statePath = path.join(tempDir, "codex-auth-provider-state.json");

  fs.writeFileSync(
    filePath,
    JSON.stringify({
      strategy: "fixed",
      accounts: [
        { id: "codex_a", credentialBundle: { headers: { authorization: "Bearer a" } }, enabled: true }
      ]
    })
  );

  const provider = new CodexAuthProvider({ codexAccountsPath: filePath, codexAuthStatePath: statePath });
  provider.invalidateAccount("codex_a");
  assert.equal(provider.resolveCredential(), null);
});
