"use strict";

const { classifyErrorType, createBridgeError, shouldFailoverAccount } = require("./errors");

function stripTrailingSlash(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function buildResponsesUrl(baseUrl) {
  const normalized = stripTrailingSlash(baseUrl || "https://api.openai.com/v1");
  const lower = normalized.toLowerCase();

  if (lower.endsWith("/responses")) {
    return normalized;
  }

  if (lower.endsWith("/v1")) {
    return normalized + "/responses";
  }

  return normalized + "/v1/responses";
}

function createSseReader(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    async next() {
      while (true) {
        const boundaryIndex = buffer.indexOf("\n\n");
        if (boundaryIndex >= 0) {
          const rawEvent = buffer.slice(0, boundaryIndex);
          buffer = buffer.slice(boundaryIndex + 2);
          const lines = rawEvent.split(/\r?\n/);
          let event = "message";
          const data = [];

          for (const line of lines) {
            if (line.startsWith("event:")) {
              event = line.slice(6).trim();
              continue;
            }

            if (line.startsWith("data:")) {
              data.push(line.slice(5).trimStart());
            }
          }

          if (data.length === 0) {
            continue;
          }

          return {
            done: false,
            value: {
              event,
              data: data.join("\n")
            }
          };
        }

        const chunk = await reader.read();
        if (chunk.done) {
          if (!buffer.trim()) {
            return { done: true, value: null };
          }

          const rawEvent = buffer;
          buffer = "";
          const lines = rawEvent.split(/\r?\n/);
          let event = "message";
          const data = [];

          for (const line of lines) {
            if (line.startsWith("event:")) {
              event = line.slice(6).trim();
              continue;
            }

            if (line.startsWith("data:")) {
              data.push(line.slice(5).trimStart());
            }
          }

          return {
            done: false,
            value: {
              event,
              data: data.join("\n")
            }
          };
        }

        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    async cancel() {
      try {
        await reader.cancel();
      } catch {
        // Ignore stream cancel failures.
      }
    }
  };
}

function upsertResponseOutputItem(items, item) {
  if (!item || typeof item !== "object") {
    return items;
  }

  const itemId = item.id || item.call_id;
  if (!itemId) {
    return items.concat([item]);
  }

  const next = items.slice();
  const index = next.findIndex((entry) => entry && (entry.id === itemId || entry.call_id === itemId));
  if (index >= 0) {
    next[index] = {
      ...next[index],
      ...item
    };
    return next;
  }

  next.push(item);
  return next;
}

function normalizeJsonStringObject(value) {
  if (!value || typeof value !== "string") {
    return value && typeof value === "object" ? value : {};
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function extractToolCallsFromResponsesOutput(output) {
  return (Array.isArray(output) ? output : [])
    .map((item) => {
      if (
        !item ||
        typeof item !== "object" ||
        !["tool_call", "function_call"].includes(item.type) ||
        !item.name
      ) {
        return null;
      }

      return {
        id: item.call_id || item.id || ("call_" + Math.random().toString(36).slice(2, 10)),
        name: String(item.name),
        input: normalizeJsonStringObject(item.arguments)
      };
    })
    .filter(Boolean);
}

function buildHeadersForCredential(bundle = {}, accept = "application/json") {
  const baseHeaders = {
    "content-type": "application/json",
    accept
  };
  const nextHeaders = {
    ...(bundle.headers && typeof bundle.headers === "object" ? bundle.headers : {}),
    ...(bundle.additionalHeaders && typeof bundle.additionalHeaders === "object" ? bundle.additionalHeaders : {})
  };

  if (!nextHeaders.authorization) {
    if (bundle.authorization) {
      nextHeaders.authorization = String(bundle.authorization);
    } else if (bundle.apiKey) {
      nextHeaders.authorization = "Bearer " + String(bundle.apiKey);
    } else if (bundle.accessToken) {
      nextHeaders.authorization = "Bearer " + String(bundle.accessToken);
    } else if (bundle.token) {
      nextHeaders.authorization = "Bearer " + String(bundle.token);
    }
  }

  if (!nextHeaders.cookie && bundle.cookie) {
    nextHeaders.cookie = String(bundle.cookie);
  }

  if (!nextHeaders["openai-organization"] && bundle.organization) {
    nextHeaders["openai-organization"] = String(bundle.organization);
  }

  if (!nextHeaders["openai-project"] && bundle.project) {
    nextHeaders["openai-project"] = String(bundle.project);
  }

  return {
    ...baseHeaders,
    ...nextHeaders
  };
}

function buildRequestError(status, message, details = null) {
  const error = new Error(message);
  error.status = status;
  error.type = classifyErrorType(status, error);
  if (details) {
    error.details = details;
  }
  return error;
}

class CodexResponsesClient {
  constructor(config = {}) {
    this.authProvider = config.authProvider || null;
    this.fetchImpl = config.fetchImpl || fetch;
    this.defaultBaseUrl = stripTrailingSlash(config.defaultBaseUrl || "https://api.openai.com/v1");
    this.requestTimeoutMs = Number(config.requestTimeoutMs || 60000) || 60000;
  }

  isAvailable() {
    return Boolean(this.authProvider && typeof this.authProvider.resolveCredential === "function");
  }

  async _requestResponses(body, credential, options = {}) {
    const headers = buildHeadersForCredential(credential.credentialBundle || {}, "text/event-stream,application/json");
    const response = await this.fetchImpl(buildResponsesUrl(credential.baseUrl || this.defaultBaseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...body,
        stream: true
      }),
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });

    if (!response.ok) {
      const rawText = await response.text().catch(() => "");
      let payload = null;

      try {
        payload = rawText ? JSON.parse(rawText) : null;
      } catch {
        payload = null;
      }

      const message =
        (payload && payload.error && payload.error.message) ||
        (payload && payload.message) ||
        rawText ||
        "Codex responses request failed: " + (response.status || 502);
      throw buildRequestError(response.status || 502, message, {
        upstream: {
          provider: "codex-responses",
          status: response.status || 502,
          body: payload || rawText || null
        }
      });
    }

    const contentType = String(response.headers.get("content-type") || "");
    if (!/text\/event-stream/i.test(contentType) || !response.body) {
      const payload = await response.json().catch(() => ({}));
      const message =
        (payload && payload.error && payload.error.message) ||
        (payload && payload.message) ||
        "Codex responses request failed: invalid response payload";
      throw buildRequestError(response.status || 502, message, {
        upstream: {
          provider: "codex-responses",
          status: response.status || 502,
          body: payload || null
        }
      });
    }

    const reader = createSseReader(response.body);
    let text = "";
    let completedResponse = null;
    let outputItems = [];

    try {
      while (true) {
        const next = await reader.next();
        if (next.done) {
          break;
        }

        const entry = next.value;
        if (!entry || !entry.data) {
          continue;
        }

        let payload;
        try {
          payload = JSON.parse(entry.data);
        } catch {
          continue;
        }

        if (payload.type === "response.output_text.delta" && typeof payload.delta === "string") {
          text += payload.delta;
          if (typeof options.onEvent === "function" && payload.delta) {
            options.onEvent({ type: "text_delta", text: payload.delta });
          }
          continue;
        }

        if (payload.type === "response.output_text.done" && typeof payload.text === "string" && !text) {
          text = payload.text;
          continue;
        }

        if (payload.type === "response.output_item.done" && payload.item && typeof payload.item === "object") {
          outputItems = upsertResponseOutputItem(outputItems, payload.item);
          if (
            typeof options.onEvent === "function" &&
            ["tool_call", "function_call"].includes(String(payload.item.type || "")) &&
            payload.item.name
          ) {
            options.onEvent({
              type: "tool_call",
              toolCall: {
                id: payload.item.call_id || payload.item.id || "call_unknown",
                name: String(payload.item.name),
                input: normalizeJsonStringObject(payload.item.arguments)
              }
            });
          }
          continue;
        }

        if (payload.type === "response.completed" && payload.response) {
          completedResponse = {
            ...payload.response,
            output: Array.isArray(payload.response.output) && payload.response.output.length > 0
              ? payload.response.output
              : outputItems
          };
          break;
        }
      }
    } finally {
      await reader.cancel();
    }

    const finalResponse = completedResponse || {
      model: body.model || null,
      output: outputItems,
      usage: null
    };

    return {
      id: finalResponse.id || null,
      finalText: text,
      toolCalls: extractToolCallsFromResponsesOutput(finalResponse.output),
      usage: finalResponse.usage || null,
      raw: finalResponse
    };
  }

  async run(body, options = {}) {
    if (!this.isAvailable()) {
      throw createBridgeError(503, "Codex responses client is not configured", "service_unavailable_error");
    }

    const triedAccounts = new Set();
    const explicitAccountId = options.accountId ? String(options.accountId) : null;
    const stickyAccountId = options.stickyAccountId ? String(options.stickyAccountId) : null;

    while (true) {
      const credential = this.authProvider.resolveCredential({
        accountId: explicitAccountId,
        stickyAccountId,
        excludeIds: [...triedAccounts]
      });

      if (!credential) {
        throw createBridgeError(503, "No usable Codex credentials available", "service_unavailable_error");
      }

      try {
        if (typeof options.onDecision === "function") {
          options.onDecision({
            type: "credential_selected",
            accountId: credential.accountId || null,
            accountName: credential.accountName || null,
            authSource: credential.source || "codex-file",
            resolvedProviderModel: body && body.model ? body.model : null
          });
        }

        const result = await this._requestResponses(body, credential, options);
        if (credential.accountId && typeof this.authProvider.clearFailure === "function") {
          this.authProvider.clearFailure(credential.accountId);
        }

        return {
          ...result,
          accountId: credential.accountId || null,
          accountName: credential.accountName || null
        };
      } catch (error) {
        if (credential.accountId && typeof this.authProvider.recordFailure === "function") {
          this.authProvider.recordFailure(credential.accountId, error);
        }

        if (
          shouldFailoverAccount(error) &&
          credential.accountId &&
          typeof this.authProvider.invalidateAccount === "function"
        ) {
          this.authProvider.invalidateAccount(credential.accountId, error.message || String(error));
        }

        if (explicitAccountId || !shouldFailoverAccount(error) || !credential.accountId) {
          throw error;
        }

        triedAccounts.add(credential.accountId);
      }
    }
  }
}

module.exports = {
  CodexResponsesClient,
  buildHeadersForCredential,
  buildResponsesUrl
};
