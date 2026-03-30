"use strict";

class RecentActivityStore {
  constructor() {
    this.lastSuccess = null;
  }

  record(entry) {
    if (!entry || typeof entry !== "object") {
      return null;
    }

    this.lastSuccess = {
      ...entry,
      recordedAt: entry.recordedAt || new Date().toISOString()
    };

    return this.lastSuccess;
  }

  get() {
    return this.lastSuccess ? { ...this.lastSuccess } : null;
  }
}

module.exports = {
  RecentActivityStore
};
