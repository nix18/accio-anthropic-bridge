"use strict";

const { CORS_HEADERS } = require("../http");

class BaseStreamWriter {
  constructor({ res, conversationId, sessionId }) {
    this.res = res;
    this.conversationId = conversationId || "";
    this.sessionId = sessionId || "";
    this.started = false;
  }

  start() {
    if (this.started || this.res.headersSent) {
      this.started = true;
      return;
    }

    this.res.writeHead(200, {
      ...CORS_HEADERS,
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accio-conversation-id": this.conversationId,
      "x-accio-session-id": this.sessionId
    });
    this.started = true;
  }
}

module.exports = { BaseStreamWriter };
