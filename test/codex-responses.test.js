"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { CodexResponsesClient, buildHeadersForCredential, buildResponsesUrl } = require("../src/codex-responses");

test("buildResponsesUrl normalizes common baseUrl forms", () => {
  assert.equal(buildResponsesUrl("https://api.openai.com"), "https://api.openai.com/v1/responses");
  assert.equal(buildResponsesUrl("https://api.openai.com/v1"), "https://api.openai.com/v1/responses");
  assert.equal(buildResponsesUrl("https://api.openai.com/v1/responses"), "https://api.openai.com/v1/responses");
});

test("buildHeadersForCredential supports opaque bundle headers and cookie", () => {
  const headers = buildHeadersForCredential({
    headers: {
      "x-test": "1"
    },
    cookie: "a=1",
    accessToken: "tok_123"
  }, "text/event-stream");

  assert.equal(headers.authorization, "Bearer tok_123");
  assert.equal(headers.cookie, "a=1");
  assert.equal(headers["x-test"], "1");
  assert.equal(headers.accept, "text/event-stream");
});

test("CodexResponsesClient completes SSE responses with text and tool calls", async () => {
  const seen = [];
  const client = new CodexResponsesClient({
    authProvider: {
      resolveCredential() {
        return {
          accountId: "codex_a",
          accountName: "Codex A",
          credentialBundle: {
            headers: {
              authorization: "Bearer opaque_token"
            }
          }
        };
      },
      recordFailure() {},
      clearFailure() {}
    },
    fetchImpl: async (url, options = {}) => {
      seen.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              'event: response.output_text.delta\n' +
              'data: {"type":"response.output_text.delta","delta":"hello"}\n\n' +
              'event: response.output_item.done\n' +
              'data: {"type":"response.output_item.done","item":{"id":"fc_1","type":"function_call","name":"lookup","arguments":"{\\"city\\":\\"Shanghai\\"}","call_id":"call_1"}}\n\n' +
              'event: response.completed\n' +
              'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5","output":[{"id":"fc_1","type":"function_call","name":"lookup","arguments":"{\\"city\\":\\"Shanghai\\"}","call_id":"call_1"}],"usage":{"input_tokens":10,"output_tokens":5}}}\n\n'
            ));
            controller.close();
          }
        })
      };
    }
  });

  const result = await client.run({
    model: "gpt-5",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
  });

  assert.equal(seen[0].url, "https://api.openai.com/v1/responses");
  assert.equal(result.finalText, "hello");
  assert.deepEqual(result.toolCalls, [
    {
      id: "call_1",
      name: "lookup",
      input: { city: "Shanghai" }
    }
  ]);
  assert.equal(result.accountId, "codex_a");
});
