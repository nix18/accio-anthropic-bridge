"use strict";

const { createBridgeError } = require("../errors");

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_BODY_READ_TIMEOUT_MS = 30 * 1000;

function readJsonBody(req, options = {}) {
  const maxBytes = Number(options.maxBytes || DEFAULT_MAX_BODY_BYTES);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_BODY_READ_TIMEOUT_MS);

  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("aborted", onAborted);
    };

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      req.destroy();
      reject(createBridgeError(408, `Request body read timed out after ${timeoutMs}ms`, "timeout_error"));
    }, timeoutMs);

    const onAborted = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(createBridgeError(400, "Request body was aborted by the client", "invalid_request_error"));
    };

    const onError = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    const onData = (chunk) => {
      if (settled) {
        return;
      }

      totalBytes += chunk.length;

      if (totalBytes > maxBytes) {
        settled = true;
        cleanup();
        req.destroy();
        reject(createBridgeError(413, `Request body exceeds ${maxBytes} bytes`, "invalid_request_error"));
        return;
      }

      chunks.push(chunk);
    };

    const onEnd = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      const text = Buffer.concat(chunks).toString("utf8").trim();

      if (!text) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(createBridgeError(400, `Invalid JSON body: ${error.message}`, "invalid_request_error"));
      }
    };

    req.on("aborted", onAborted);
    req.on("error", onError);
    req.on("data", onData);
    req.on("end", onEnd);
  });
}

module.exports = {
  DEFAULT_BODY_READ_TIMEOUT_MS,
  DEFAULT_MAX_BODY_BYTES,
  readJsonBody
};
