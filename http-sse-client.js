"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HttpSseTransport = void 0;
const adk_llm_gateway_1 = require("../generated/adk_llm_gateway");
const debug_1 = require("./debug");
/**
 * camelCase → snake_case 递归转换。
 *
 * ts-proto 的 toJSON() 输出 camelCase 字段名（如 includeThoughts），
 * 但网关 HTTP API 遵循 proto JSON 规范，使用 snake_case（如 include_thoughts）。
 */
function toSnakeCase(str) {
    return str.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}
function keysToSnakeCase(obj) {
    if (obj === null || obj === undefined)
        return obj;
    if (Array.isArray(obj))
        return obj.map(keysToSnakeCase);
    if (typeof obj === "object") {
        const result = {};
        for (const [key, value] of Object.entries(obj)) {
            result[toSnakeCase(key)] = keysToSnakeCase(value);
        }
        return result;
    }
    return obj;
}
/**
 * HTTP SSE 传输层实现。
 *
 * 通过 HTTP POST + Server-Sent Events 与网关通信，
 * 每个 SSE event 的 data 字段为 GenerateContentResponse 的 JSON 表示。
 */
class HttpSseTransport {
    constructor(config) {
        this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    }
    async *streamGenerateContent(request) {
        this.abortController = new AbortController();
        const camelBody = adk_llm_gateway_1.GenerateContentRequest.toJSON(request);
        const body = keysToSnakeCase(camelBody);
        const url = `${this.baseUrl}/generateContent`;
        const bodyJson = JSON.stringify(body);
        const debug = (0, debug_1.isLlmDebugEnabled)();
        if (debug) {
            const snakeBody = body;
            (0, debug_1.infoLog)("[Gateway:Request]", {
                url,
                model: snakeBody.model,
                empid: snakeBody.empid,
                tenant: snakeBody.tenant,
                request_id: snakeBody.request_id,
                contents: `${snakeBody.contents?.length ?? 0} messages`,
                tools: `${snakeBody.tools?.length ?? 0} tools`,
                temperature: snakeBody.temperature,
                max_output_tokens: snakeBody.max_output_tokens,
                include_thoughts: snakeBody.include_thoughts,
                thinking_level: snakeBody.thinking_level,
                timeout: snakeBody.timeout,
            });
        }
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "text/event-stream",
            },
            body: bodyJson,
            signal: this.abortController.signal,
        });
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            const errMsg = `HTTP SSE request failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`;
            if (debug) {
                (0, debug_1.errorLog)("[Gateway:Error]", {
                    status: response.status,
                    statusText: response.statusText,
                    body: text,
                });
            }
            throw new Error(errMsg);
        }
        if (!response.body) {
            throw new Error("HTTP SSE response has no body");
        }
        for await (const event of parseSseStream(response.body)) {
            if (!event.data || event.data === "[DONE]")
                continue;
            const parsed = JSON.parse(event.data);
            if (isProtoResponse(parsed)) {
                yield adk_llm_gateway_1.GenerateContentResponse.fromJSON(parsed);
            }
            else {
                if (debug) {
                    (0, debug_1.infoLog)("[Gateway:Passthrough]", parsed);
                }
                yield { _tag: "gateway_passthrough", payload: parsed };
            }
        }
    }
    close() {
        this.abortController?.abort();
        this.abortController = undefined;
    }
}
exports.HttpSseTransport = HttpSseTransport;
/**
 * 将 ReadableStream<Uint8Array> 解析为 SSE 事件流。
 *
 * 遵循 SSE 规范：以空行分隔事件，每行格式为 "field: value"。
 * 支持多行 data 拼接。
 */
async function* parseSseStream(stream) {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let buffer = "";
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop();
            for (const part of parts) {
                const event = parseSseBlock(part);
                if (event)
                    yield event;
            }
        }
        if (buffer.trim()) {
            const event = parseSseBlock(buffer);
            if (event)
                yield event;
        }
    }
    finally {
        reader.releaseLock();
    }
}
function parseSseBlock(block) {
    const lines = block.split("\n");
    let event;
    const dataLines = [];
    for (const line of lines) {
        if (line.startsWith(":"))
            continue;
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1)
            continue;
        const field = line.slice(0, colonIdx);
        const value = line.slice(colonIdx + 1).replace(/^ /, "");
        switch (field) {
            case "event":
                event = value;
                break;
            case "data":
                dataLines.push(value);
                break;
        }
    }
    if (dataLines.length === 0 && !event)
        return null;
    return {
        event,
        data: dataLines.join("\n"),
    };
}
// ==================== Proto 响应检测 ====================
/**
 * 判断 SSE event data 解析后的 JSON 是否为 proto GenerateContentResponse。
 *
 * 网关返回的 proto 响应必定包含 raw_response_json 字段（网关总会透传上游原始 JSON）。
 * 网关自身产生的业务消息（登录异常、额度不足等）不会包含此字段。
 */
function isProtoResponse(json) {
    return "raw_response_json" in json || "rawResponseJson" in json;
}
//# sourceMappingURL=http-sse-client.js.map