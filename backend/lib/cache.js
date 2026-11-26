'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Simple on-disk response cache for repeated research queries.
class DiskCache {
  constructor(dir, ttlMs = 24 * 60 * 60 * 1000) {
    this.dir = dir;
    this.ttlMs = ttlMs;
    fs.mkdirSync(dir, { recursive: true });
  }

  key(payload) {
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
  }

  get(key) {
    const file = path.join(this.dir, `${key}.json`);
    try {
      const stat = fs.statSync(file);
      if (Date.now() - stat.mtimeMs > this.ttlMs) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  set(key, value) {
    const file = path.join(this.dir, `${key}.json`);
    try {
      fs.writeFileSync(file, JSON.stringify(value));
    } catch {
      // Cache write failures must never break a research request.
    }
  }
}

// Small in-memory fixed-window rate limiter, per client IP.
class RateLimiter {
  constructor({ windowMs = 60_000, max = 10 } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
  }

  allow(ip) {
    const now = Date.now();
    const entry = this.hits.get(ip) || [];
    const recent = entry.filter(timestamp => now - timestamp < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(ip, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(ip, recent);
    if (this.hits.size > 500) {
      for (const [key, value] of this.hits) {
        if (value.every(timestamp => now - timestamp >= this.windowMs)) this.hits.delete(key);
      }
    }
    return true;
  }
}

module.exports = { DiskCache, RateLimiter };
