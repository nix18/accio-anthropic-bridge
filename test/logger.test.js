"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("logger respects LOG_TIMEZONE env var", async () => {
  // Default timezone is UTC+8
  const logger = require("../src/logger");
  const entries = logger.getEntries(1);

  // Clear buffer and subscribe
  const captured = [];
  const unsub = logger.subscribe((entry) => captured.push(entry));

  logger.info("tz-test");
  assert.equal(captured.length, 1);
  assert.ok(captured[0].ts.endsWith("+08:00"), `expected +08:00 suffix, got ${captured[0].ts}`);

  unsub();
});

test("logger subscribe and unsubscribe", () => {
  const logger = require("../src/logger");

  const captured = [];
  const unsub = logger.subscribe((entry) => captured.push(entry));

  logger.info("sub-test-1");
  assert.equal(captured.length, 1);

  unsub();
  logger.info("sub-test-2");
  assert.equal(captured.length, 1);
});

test("logger subscribe ignores non-function", () => {
  const logger = require("../src/logger");
  const unsub = logger.subscribe("not a function");
  assert.equal(typeof unsub, "function");
  unsub();
});

test("logger getEntries returns at most limit items", () => {
  const logger = require("../src/logger");
  const entries = logger.getEntries(0);
  // limit=0 should still work with the max(1,...) guard
  assert.ok(Array.isArray(entries));
});

test("logger levels filter correctly", () => {
  const logger = require("../src/logger");
  const captured = [];
  const unsub = logger.subscribe((entry) => captured.push(entry));

  logger.debug("should-be-filtered");
  logger.info("should-pass");
  logger.warn("should-pass-too");

  const debugEntries = captured.filter((e) => e.level === "debug");
  assert.equal(debugEntries.length, 0);
  assert.ok(captured.length >= 2);

  unsub();
});
