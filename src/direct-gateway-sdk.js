"use strict";

const DIRECT_GATEWAY_DEFAULT_IAI_TAG = "phoenix-desktop";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toSnakeCase(value) {
  return String(value || "").replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

function keysToSnakeCase(value) {
  if (Array.isArray(value)) {
    return value.map((item) => keysToSnakeCase(item));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [toSnakeCase(key), keysToSnakeCase(item)])
  );
}

function compactGatewayValue(value) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string") {
    return value === "" ? undefined : value;
  }

  if (Array.isArray(value)) {
    const items = value
      .map((item) => compactGatewayValue(item))
      .filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const compacted = {};

  for (const [key, item] of Object.entries(value)) {
    const normalized = compactGatewayValue(item);

    if (normalized !== undefined) {
      compacted[key] = normalized;
    }
  }

  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function normalizeString(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim();
}

function normalizeOptionalNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeOptionalBoolean(value) {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => normalizeString(item))
    .filter(Boolean);
}

function createGenerateContentRequest(source = {}) {
  const request = {
    model: normalizeString(source.model),
    empid: normalizeString(source.empid),
    tenant: normalizeString(source.tenant),
    iaiTag: normalizeString(source.iaiTag || source.iai_tag) || DIRECT_GATEWAY_DEFAULT_IAI_TAG,
    requestId: normalizeString(source.requestId || source.request_id),
    contents: Array.isArray(source.contents) ? source.contents : [],
    systemInstruction: normalizeString(source.systemInstruction || source.system_instruction),
    tools: Array.isArray(source.tools) ? source.tools : [],
    temperature: normalizeOptionalNumber(source.temperature),
    maxOutputTokens: normalizeOptionalNumber(source.maxOutputTokens ?? source.max_output_tokens),
    timeout: normalizeOptionalNumber(source.timeout),
    includeThoughts: normalizeOptionalBoolean(source.includeThoughts ?? source.include_thoughts),
    thinkingBudget: normalizeOptionalNumber(source.thinkingBudget ?? source.thinking_budget),
    thinkingLevel: normalizeString(source.thinkingLevel || source.thinking_level),
    reasoningEffort: normalizeString(source.reasoningEffort || source.reasoning_effort),
    topP: normalizeOptionalNumber(source.topP ?? source.top_p),
    stopSequences: normalizeStringArray(source.stopSequences || source.stop_sequences),
    toolChoice: normalizeString(source.toolChoice || source.tool_choice),
    responseFormat: normalizeString(source.responseFormat || source.response_format),
    properties: isPlainObject(source.properties) ? source.properties : {},
    token: normalizeString(source.token),
    messageId: normalizeString(source.messageId || source.message_id)
  };

  return compactGatewayValue(request) || {};
}

function serializeGenerateContentRequest(source = {}) {
  return keysToSnakeCase(createGenerateContentRequest(source));
}

module.exports = {
  DIRECT_GATEWAY_DEFAULT_IAI_TAG,
  createGenerateContentRequest,
  keysToSnakeCase,
  serializeGenerateContentRequest
};
