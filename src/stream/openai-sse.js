"use strict";

const { buildChatCompletionChunk } = require("../openai");
const { BaseStreamWriter } = require("./base-writer");
const { generateId } = require("../id");

class OpenAiStreamWriter extends BaseStreamWriter {
  constructor({ body, res, created, id, conversationId, sessionId }) {
    super({ res, conversationId, sessionId });
    this.body = body;
    this.created = created || Math.floor(Date.now() / 1000);
    this.id = id || generateId("chatcmpl");
    this.wroteAssistantRole = false;
  }

  writeChunk(delta, extras = {}) {
    this.start();
    this.res.write(
      `data: ${JSON.stringify(
        buildChatCompletionChunk(this.body, delta, {
          created: this.created,
          id: this.id,
          ...extras
        })
      )}\n\n`
    );
  }

  ensureAssistantRole() {
    if (this.wroteAssistantRole) {
      return;
    }

    this.writeChunk({ role: "assistant" });
    this.wroteAssistantRole = true;
  }

  writeContent(content) {
    if (!content) {
      return;
    }

    this.ensureAssistantRole();
    this.writeChunk({ content });
  }

  writeToolCall(toolCall) {
    this.ensureAssistantRole();
    this.writeChunk({
      tool_calls: [
        {
          index: 0,
          id: toolCall.id,
          type: "function",
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.input || {})
          }
        }
      ]
    });
  }

  finish(finishReason) {
    this.writeChunk({}, { finishReason });
    this.res.write("data: [DONE]\n\n");
    this.res.end();
  }
}

module.exports = {
  OpenAiStreamWriter
};
