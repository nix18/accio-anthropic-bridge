"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");
const assert = require("node:assert/strict");

const { SessionStore } = require("../src/session-store");
const { ResponseCache } = require("../src/response-cache");
const { handleChatCompletionsRequest, handleModelsRequest, handleResponsesRequest } = require("../src/routes/openai");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "accio-routes-test-"));
}

function createMockReq(body, headers = {}) {
  const req = new Readable({ read() {} });
  req.headers = { "content-type": "application/json", ...headers };
  req.bridgeContext = { requestId: "test-req-1", bodyParser: { maxBytes: 1024 * 1024 } };
  process.nextTick(() => {
    req.push(JSON.stringify(body));
    req.push(null);
  });
  return req;
}

function createMockRes() {
  const res = {
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    _statusCode: null,
    _headers: {},
    _chunks: [],
    writeHead(statusCode, headers) {
      res._statusCode = statusCode;
      res._headers = { ...res._headers, ...headers };
      res.headersSent = true;
    },
    write(chunk) {
      res._chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    },
    end(data) {
      if (data) res._chunks.push(typeof data === "string" ? data : Buffer.from(data).toString());
      res.writableEnded = true;
    }
  };
  return res;
}

function createMockDirectClient(response) {
  return {
    isAvailable: () => true,
    run: async () => response
  };
}

function createMockClient() {
  return { config: { defaultMaxOutputTokens: 0, transportMode: "direct" } };
}

function createMockSessionStore() {
  const dir = makeTempDir();
  return new SessionStore(path.join(dir, "sessions.json"));
}

const BASIC_BODY = {
  model: "gpt-4o",
  messages: [{ role: "user", content: "hello" }],
  stream: false
};

const DIRECT_RESPONSE = {
  finalText: "Hello from direct LLM!",
  usage: { promptTokenCount: 10, candidatesTokenCount: 5 },
  accountId: "acct_test",
  accountName: "Test Account",
  id: "resp_001",
  toolCalls: []
};

/* ─── handleModelsRequest ─── */

test("handleModelsRequest returns model list", async () => {
  const req = createMockReq({});
  const res = createMockRes();
  const modelsRegistry = { listModels: async () => [{ id: "gpt-4o" }, { id: "claude-3" }] };

  await handleModelsRequest(req, res, modelsRegistry);

  assert.equal(res._statusCode, 200);
  const body = JSON.parse(res._chunks.join(""));
  assert.equal(body.object, "list");
  assert.equal(body.data.length, 2);
  assert.equal(body.data[0].id, "gpt-4o");
});

/* ─── handleChatCompletionsRequest: direct non-streaming ─── */

test("handleChatCompletionsRequest: direct non-streaming returns 200", async () => {
  const req = createMockReq(BASIC_BODY);
  const res = createMockRes();
  const client = createMockClient();
  const directClient = createMockDirectClient(DIRECT_RESPONSE);
  const sessionStore = createMockSessionStore();

  await handleChatCompletionsRequest(req, res, client, directClient, null, sessionStore, null);

  assert.equal(res._statusCode, 200);
  const body = JSON.parse(res._chunks.join(""));
  assert.equal(body.object, "chat.completion");
  assert.equal(body.choices[0].message.content, "Hello from direct LLM!");
  assert.equal(body.model, "gpt-4o");
});

/* ─── handleChatCompletionsRequest: cache hit ─── */

test("handleChatCompletionsRequest: returns cached response on hit", async () => {
  const cache = new ResponseCache({ ttlMs: 60000, maxEntries: 10 });

  const req1 = createMockReq(BASIC_BODY);
  const res1 = createMockRes();
  const client = createMockClient();
  const directClient = createMockDirectClient(DIRECT_RESPONSE);
  const sessionStore = createMockSessionStore();

  // First request populates cache
  await handleChatCompletionsRequest(req1, res1, client, directClient, null, sessionStore, cache);
  assert.equal(res1._statusCode, 200);

  // Second request should hit cache — directClient should NOT be called again
  const directClient2 = {
    isAvailable: () => true,
    run: async () => { throw new Error("should not reach here"); }
  };
  const req2 = createMockReq(BASIC_BODY);
  const res2 = createMockRes();

  await handleChatCompletionsRequest(req2, res2, client, directClient2, null, sessionStore, cache);
  assert.equal(res2._statusCode, 200);
  const body2 = JSON.parse(res2._chunks.join(""));
  assert.equal(body2.choices[0].message.content, "Hello from direct LLM!");
  assert.ok(res2._headers["x-accio-cache"] === "hit");
});

/* ─── handleChatCompletionsRequest: direct transport unavailable throws 503 ─── */

test("handleChatCompletionsRequest: throws 503 when direct unavailable and no fallback", async () => {
  const req = createMockReq(BASIC_BODY);
  const res = createMockRes();
  const client = createMockClient();
  const directClient = { isAvailable: () => false };
  const sessionStore = createMockSessionStore();

  await assert.rejects(
    () => handleChatCompletionsRequest(req, res, client, directClient, null, sessionStore, null),
    (err) => err.status === 503
  );
});

/* ─── handleChatCompletionsRequest: streaming ─── */

test("handleChatCompletionsRequest: streaming returns SSE chunks", async () => {
  const body = { ...BASIC_BODY, stream: true };
  const req = createMockReq(body);
  const res = createMockRes();
  const client = createMockClient();

  const directClient = {
    isAvailable: () => true,
    run: async (_request, options) => {
      // Simulate onEvent callbacks
      if (options.onEvent) {
        options.onEvent({ type: "text_delta", text: "Hello" });
        options.onEvent({ type: "text_delta", text: " world" });
      }
      return DIRECT_RESPONSE;
    }
  };
  const sessionStore = createMockSessionStore();

  await handleChatCompletionsRequest(req, res, client, directClient, null, sessionStore, null);

  const output = res._chunks.join("");
  assert.ok(output.includes("data: [DONE]"));
  assert.ok(res._headers["content-type"] && res._headers["content-type"].includes("text/event-stream"));
});

/* ─── handleChatCompletionsRequest: with tool calls ─── */

test("handleChatCompletionsRequest: non-streaming with tool calls", async () => {
  const body = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "weather?" }],
    stream: false,
    tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }]
  };
  const req = createMockReq(body);
  const res = createMockRes();
  const client = createMockClient();
  const directClient = createMockDirectClient({
    finalText: "",
    usage: { promptTokenCount: 10, candidatesTokenCount: 5 },
    accountId: null,
    accountName: null,
    id: "resp_002",
    toolCalls: [{ id: "call_1", name: "get_weather", input: { city: "Shanghai" } }]
  });
  const sessionStore = createMockSessionStore();

  await handleChatCompletionsRequest(req, res, client, directClient, null, sessionStore, null);

  assert.equal(res._statusCode, 200);
  const responseBody = JSON.parse(res._chunks.join(""));
  assert.equal(responseBody.choices[0].finish_reason, "tool_calls");
  assert.equal(responseBody.choices[0].message.tool_calls[0].function.name, "get_weather");
});

/* ─── handleChatCompletionsRequest: session binding ─── */

test("handleChatCompletionsRequest: merges session info after direct response", async () => {
  const headers = { "x-accio-session-id": "sess_test_1" };
  const req = createMockReq(BASIC_BODY, headers);
  const res = createMockRes();
  const client = createMockClient();
  const directClient = createMockDirectClient(DIRECT_RESPONSE);
  const sessionStore = createMockSessionStore();

  await handleChatCompletionsRequest(req, res, client, directClient, null, sessionStore, null);

  const entry = sessionStore.get("sess_test_1");
  assert.ok(entry);
  assert.equal(entry.accountId, "acct_test");
  assert.equal(entry.lastTransport, "direct-llm");
});

/* ─── handleChatCompletionsRequest: invalid messages ─── */

test("handleChatCompletionsRequest: rejects invalid tool_call", async () => {
  const body = {
    model: "gpt-4o",
    messages: [
      { role: "user", content: "test" },
      { role: "assistant", tool_calls: [{ id: null, function: {} }] }
    ],
    stream: false
  };
  const req = createMockReq(body);
  const res = createMockRes();
  const client = createMockClient();
  const directClient = createMockDirectClient(DIRECT_RESPONSE);
  const sessionStore = createMockSessionStore();

  await assert.rejects(
    () => handleChatCompletionsRequest(req, res, client, directClient, null, sessionStore, null),
    (err) => err.status === 400
  );
});

/* ─── handleChatCompletionsRequest: external fallback ─── */

test("handleChatCompletionsRequest: falls back to external provider", async () => {
  const req = createMockReq(BASIC_BODY);
  const res = createMockRes();
  const client = createMockClient();

  // Direct client throws, triggering fallback
  const directClient = {
    isAvailable: () => true,
    run: async () => { throw Object.assign(new Error("rate limit"), { status: 429 }); }
  };

  const fallbackPool = {
    getEligibleOpenAi: () => [{
      client: {
        protocol: "openai",
        model: "fallback-model",
        completeOpenAi: async () => ({
          text: "Fallback response",
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        })
      }
    }]
  };
  const sessionStore = createMockSessionStore();

  await handleChatCompletionsRequest(req, res, client, directClient, fallbackPool, sessionStore, null);

  assert.equal(res._statusCode, 200);
  const body = JSON.parse(res._chunks.join(""));
  assert.equal(body.choices[0].message.content, "Fallback response");
});

/* ─── handleResponsesRequest: non-streaming ─── */

test("handleResponsesRequest: non-streaming returns response API format", async () => {
  const body = {
    model: "gpt-4o",
    input: [{ role: "user", content: "hello" }],
    stream: false
  };
  const req = createMockReq(body);
  const res = createMockRes();
  const client = createMockClient();
  const directClient = createMockDirectClient(DIRECT_RESPONSE);
  const sessionStore = createMockSessionStore();

  await handleResponsesRequest(req, res, client, directClient, null, sessionStore, null);

  assert.equal(res._statusCode, 200);
  const responseBody = JSON.parse(res._chunks.join(""));
  assert.equal(responseBody.status, "completed");
  assert.ok(Array.isArray(responseBody.output));
  assert.ok(responseBody.output.some((item) => item.type === "message"));
});

/* ─── handleResponsesRequest: streaming ─── */

test("handleResponsesRequest: streaming emits SSE events", async () => {
  const body = {
    model: "gpt-4o",
    input: [{ role: "user", content: "hello" }],
    stream: true
  };
  const req = createMockReq(body);
  const res = createMockRes();
  const client = createMockClient();
  const directClient = createMockDirectClient(DIRECT_RESPONSE);
  const sessionStore = createMockSessionStore();

  await handleResponsesRequest(req, res, client, directClient, null, sessionStore, null);

  const output = res._chunks.join("");
  assert.ok(output.includes("response.completed"));
  assert.ok(output.includes("response.created"));
  assert.ok(res.writableEnded);
});

/* ─── handleResponsesRequest: cache hit ─── */

test("handleResponsesRequest: returns cached response on hit", async () => {
  const cache = new ResponseCache({ ttlMs: 60000, maxEntries: 10 });
  const body = {
    model: "gpt-4o",
    input: [{ role: "user", content: "cache test" }],
    stream: false
  };
  const client = createMockClient();
  const directClient = createMockDirectClient(DIRECT_RESPONSE);
  const sessionStore = createMockSessionStore();

  // First request populates cache
  const req1 = createMockReq(body);
  const res1 = createMockRes();
  await handleResponsesRequest(req1, res1, client, directClient, null, sessionStore, cache);

  // Second request should hit cache
  const directClient2 = {
    isAvailable: () => true,
    run: async () => { throw new Error("should not reach here"); }
  };
  const req2 = createMockReq(body);
  const res2 = createMockRes();
  await handleResponsesRequest(req2, res2, client, directClient2, null, sessionStore, cache);

  assert.equal(res2._statusCode, 200);
  assert.ok(res2._headers["x-accio-cache"] === "hit");
});

/* ─── handleChatCompletionsRequest: direct streaming error ─── */

test("handleChatCompletionsRequest: streaming error writes SSE error block", async () => {
  const body = { ...BASIC_BODY, stream: true };
  const req = createMockReq(body);
  const res = createMockRes();
  const client = createMockClient();

  const directClient = {
    isAvailable: () => true,
    run: async (_request, options) => {
      if (options.onEvent) {
        options.onEvent({ type: "text_delta", text: "partial" });
      }
      throw Object.assign(new Error("upstream crashed"), { status: 500 });
    }
  };

  const fallbackPool = { getEligibleOpenAi: () => [] };
  const sessionStore = createMockSessionStore();

  // When headers have been sent (streaming started), error is handled gracefully
  // — writes SSE error data block + [DONE], returns normally
  await handleChatCompletionsRequest(req, res, client, directClient, fallbackPool, sessionStore, null);

  const output = res._chunks.join("");
  assert.ok(output.includes("data: [DONE]"));
  assert.ok(res.writableEnded);
});
