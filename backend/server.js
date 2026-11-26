'use strict';

// SupplyChain Intelligence — AI Research Assistant backend.
// Zero-dependency Node.js server (Node 18+): serves the existing frontend and
// exposes /api endpoints for AI research. All API keys stay in environment
// variables (or a local .env file) and are never sent to the browser.

const http = require('http');
const fs = require('fs');
const path = require('path');

const { conductResearch, RESEARCH_MODES } = require('./lib/research');
const { providerConfig } = require('./lib/ai');
const { searchProviders } = require('./lib/search');
const { DiskCache, RateLimiter } = require('./lib/cache');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.join(__dirname, '..');
const FRONTEND_FILE = path.join(ROOT, 'supplychain-intelligence-global-map.html');
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 240_000;

// ---------------------------------------------------------------------------
// Minimal .env loader (no dependency on the dotenv package).
// ---------------------------------------------------------------------------
function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || line.trim().startsWith('#')) continue;
    const [, key, raw] = match;
    const value = raw.replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const cache = new DiskCache(path.join(__dirname, '.cache'));
const limiter = new RateLimiter({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_PER_MINUTE || 10) });

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large.'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON body.'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function validateResearchPayload(payload) {
  const question = typeof payload.question === 'string' ? payload.question.trim() : '';
  if (question.length < 3) return { error: 'A research question of at least 3 characters is required.' };
  if (question.length > 1000) return { error: 'Research question is limited to 1000 characters.' };
  const mode = payload.mode && RESEARCH_MODES.includes(payload.mode) ? payload.mode : 'auto';
  const db = payload.db && typeof payload.db === 'object' ? payload.db : null;
  if (!db || !Array.isArray(db.companies) || !Array.isArray(db.relationships)) {
    return { error: 'A database snapshot (db.companies and db.relationships) is required.' };
  }
  return { question, mode, db };
}

function healthPayload() {
  const ai = providerConfig();
  return {
    ok: true,
    ai: { configured: ai.configured, provider: ai.configured ? ai.provider : null, model: ai.configured ? ai.model : null, error: ai.configured ? null : ai.error },
    search: { providers: searchProviders(), keyless: ['edgar'] },
    modes: RESEARCH_MODES
  };
}

async function handleApi(request, response, pathname) {
  if (pathname === '/api/health' && request.method === 'GET') {
    return sendJson(response, 200, healthPayload());
  }

  if (pathname === '/api/research' && request.method === 'POST') {
    let payload;
    try {
      payload = await readBody(request);
    } catch (error) {
      return sendJson(response, error.statusCode || 400, { error: error.message });
    }
    if (!limiter.allow(request.socket.remoteAddress || 'unknown')) {
      return sendJson(response, 429, { error: 'Research request limit reached (10 per minute). Please wait a moment.' });
    }
    const validated = validateResearchPayload(payload);
    if (validated.error) return sendJson(response, 400, { error: validated.error });

    const { question, mode, db } = validated;
    const cacheKey = cache.key({ question: question.toLowerCase(), mode, companyCount: db.companies.length, relationshipCount: db.relationships.length });
    const cached = cache.get(cacheKey);
    if (cached) {
      return sendJson(response, 200, { ...cached, meta: { ...cached.meta, cached: true } });
    }

    try {
      const result = await conductResearch(question, mode, db);
      const payloadOut = { ...result, question, mode };
      cache.set(cacheKey, payloadOut);
      return sendJson(response, 200, payloadOut);
    } catch (error) {
      const step = error.step ? ` during "${error.step}"` : '';
      console.error(`[research] failed${step}:`, error.message);
      const status = error.code === 'AI_NOT_CONFIGURED' ? 503 : 502;
      return sendJson(response, status, {
        error: `Research failed${step}: ${error.message}`,
        hint: error.code === 'AI_NOT_CONFIGURED'
          ? 'Configure an AI provider API key in backend/.env (see README) or keep using the dataset-only mode.'
          : 'Check the backend console for details. The request was not cached; you can retry.'
      });
    }
  }

  return sendJson(response, 404, { error: 'Unknown API endpoint.' });
}

function serveStatic(response, pathname) {
  const filePath = pathname === '/' || pathname === '' ? FRONTEND_FILE : path.join(ROOT, pathname);
  const resolved = path.resolve(filePath);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    response.writeHead(403); response.end('Forbidden'); return;
  }
  fs.readFile(resolved, (error, data) => {
    if (error) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('Not found');
      return;
    }
    const type = resolved.endsWith('.html') ? 'text/html; charset=utf-8'
      : resolved.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : resolved.endsWith('.css') ? 'text/css; charset=utf-8'
      : 'application/octet-stream';
    response.writeHead(200, { 'content-type': type });
    response.end(data);
  });
}

loadEnvFile();

const server = http.createServer(async (request, response) => {
  const requestTimer = setTimeout(() => {
    if (!response.headersSent) {
      response.writeHead(504, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: `Research request exceeded ${REQUEST_TIMEOUT_MS / 1000}s and was aborted. Try a narrower question.` }));
    }
  }, REQUEST_TIMEOUT_MS);
  response.on('finish', () => clearTimeout(requestTimer));

  try {
    const { pathname } = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (pathname.startsWith('/api/')) {
      await handleApi(request, response, pathname);
    } else if (request.method === 'GET') {
      serveStatic(response, decodeURIComponent(pathname));
    } else {
      sendJson(response, 405, { error: 'Method not allowed.' });
    }
  } catch (error) {
    console.error('[server] unexpected error:', error);
    if (!response.headersSent) sendJson(response, 500, { error: 'Internal server error.' });
  }
});

server.listen(PORT, HOST, () => {
  const health = healthPayload();
  console.log(`SupplyChain Intelligence backend running at http://localhost:${PORT}`);
  console.log(`  AI provider:    ${health.ai.configured ? `${health.ai.provider} (${health.ai.model})` : 'NOT CONFIGURED — dataset-only mode'}`);
  console.log(`  Search sources: ${health.search.providers.join(', ')}`);
  if (!health.ai.configured) console.log('  Set API keys in backend/.env to enable live AI research (see README).');
});
