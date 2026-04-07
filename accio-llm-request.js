"use strict";
/**
 * Accio LLM 请求模型与辅助函数。
 *
 * contents 使用 @google/genai 的 Content 类型，与 Python 版 AccioLlmRequest 一致。
 * 发送给网关前通过 proto-converter 转换为 proto GenerateContentRequest。
 *
 * 对应 Python 版: accio_adk.llm.AccioLlmRequest
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAccioLlmRequest = createAccioLlmRequest;
exports.getIaiTag = getIaiTag;
exports.getRequestId = getRequestId;
exports.getTimeout = getTimeout;
exports.getRetry = getRetry;
/**
 * 创建 AccioLlmRequest，对未提供的字段填充默认值。
 */
function createAccioLlmRequest(init) {
    return {
        model: init.model ?? "",
        empid: init.empid ?? "",
        tenant: init.tenant ?? "",
        iaiTag: init.iaiTag ?? "",
        requestId: init.requestId ?? `req-${Date.now()}`,
        messageId: init.messageId,
        contents: init.contents ?? [],
        systemInstruction: init.systemInstruction ?? "",
        tools: init.tools ?? [],
        temperature: init.temperature,
        maxOutputTokens: init.maxOutputTokens,
        timeout: init.timeout,
        includeThoughts: init.includeThoughts,
        thinkingBudget: init.thinkingBudget,
        thinkingLevel: init.thinkingLevel,
        reasoningEffort: init.reasoningEffort,
        topP: init.topP,
        stopSequences: init.stopSequences,
        toolChoice: init.toolChoice,
        responseFormat: init.responseFormat,
        properties: init.properties,
        generationConfig: init.generationConfig,
        customMetadata: init.customMetadata,
        stream: init.stream,
        incremental: init.incremental,
        retry: init.retry,
    };
}
// ==================== 辅助函数（对应 Python 版的 get_xxx 方法）====================
function getIaiTag(req, defaultValue) {
    if (req.iaiTag)
        return req.iaiTag;
    const fromMeta = req.customMetadata?.["iai_tag"];
    if (typeof fromMeta === "string" && fromMeta)
        return fromMeta;
    return defaultValue;
}
function getRequestId(req) {
    if (req.requestId && req.requestId !== "unknown")
        return req.requestId;
    const fromMeta = req.customMetadata?.["request_id"];
    if (typeof fromMeta === "string" && fromMeta)
        return fromMeta;
    return "unknown";
}
function getTimeout(req, defaultValue = 120.0) {
    if (req.timeout != null)
        return req.timeout;
    const fromMeta = req.customMetadata?.["timeout"];
    if (fromMeta != null)
        return Number(fromMeta);
    return defaultValue;
}
function getRetry(req, defaultValue = 0) {
    if (req.retry != null)
        return req.retry;
    const fromMeta = req.customMetadata?.["retry"];
    if (fromMeta != null)
        return Number(fromMeta);
    return defaultValue;
}
//# sourceMappingURL=accio-llm-request.js.map