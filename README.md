# SupplyChain Intelligence

A dark, Bloomberg-Terminal-inspired supply-chain intelligence platform with an
**AI Research Assistant** for investigating publicly traded companies, their
suppliers, customers, manufacturing networks and investment opportunities.

## What's inside

| Part | Description |
|---|---|
| `supplychain-intelligence-global-map.html` | The complete frontend (single file): company database, relationship graph, supply-chain tables, watchlist, global map and the AI Research Assistant UI. |
| `backend/server.js` | Zero-dependency Node.js backend that serves the frontend and exposes the AI research API. |
| `backend/lib/ai.js` | Configurable AI provider layer (OpenAI-compatible, Anthropic, Mistral). |
| `backend/lib/search.js` | Live web research: Tavily / Brave / Google CSE / SerpApi plus keyless SEC EDGAR full-text search and page retrieval. |
| `backend/lib/research.js` | Research orchestration: plan → database context → evidence gathering → grounded report synthesis → citation sanitization. |
| `backend/lib/db-research.js` | Deterministic research over your own dataset (dataset-only mode with no API keys). |
| `backend/lib/cache.js` | Disk cache for repeated questions + per-client rate limiting. |

## Quick start (Windows)

1. Install [Node.js 18 or newer](https://nodejs.org/) (Node 20/22 recommended).
2. Open a terminal in the project folder and configure API keys:

   ```bat
   copy backend\.env.example backend\.env
   notepad backend\.env
   ```

   Set **one** AI provider key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or
   `MISTRAL_API_KEY`) and optionally a web-search key (`TAVILY_API_KEY`,
   `BRAVE_API_KEY`, `GOOGLE_API_KEY` + `GOOGLE_CSE_ID`, or `SERPAPI_KEY`).
   Keys stay in `backend/.env` on your machine and are never sent to the browser.

3. Start the backend:

   ```bat
   node backend\server.js
   ```

4. Open **http://localhost:3000** and use the **AI Research Assistant** tab.

No `npm install` is required — the backend uses only Node.js built-ins.

### Running modes

- **Full AI research** (AI key + search key set): the assistant plans the
  research, searches live public sources (filings, press releases, credible
  media, SEC EDGAR), verifies relationships against retrieved evidence and
  returns an evidence-cited report.
- **Dataset-only mode** (no keys): the app still works. Reports are built
  deterministically from your existing company database and its own source
  records — nothing is invented, and the UI clearly labels the mode.

## How accuracy is enforced

- Every relationship claim must be backed by evidence retrieved during the
  request or by your own dataset (`db:` citations resolve to your records).
- Citations that cannot be matched to real retrieved sources are dropped
  before the report is shown; claims that lose all citations are downgraded
  to "inferred / low confidence".
- Claim statuses: **Confirmed** (primary/official source), **Reported**
  (credible media), **Inferred** (analytical reasoning), **Unverified**.
- Repeated questions are served from a 24-hour disk cache; research history
  lives in your browser's local storage.

## API

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/health` | GET | Whether an AI provider and search sources are configured (never returns keys). |
| `/api/research` | POST | `{ question, mode, db }` → structured, evidence-cited research report. |

The frontend sends a snapshot of your current company/relationship database
with each request so the assistant reasons over your live data, including
companies you approved from earlier research sessions.

## Notes

- Research requests are rate-limited (10/minute by default) and time-boxed.
- SEC EDGAR works without an API key but identifies requests via
  `SEC_USER_AGENT` (set a contact email in `backend/.env`).
- The frontend also opens standalone as a file, but AI research requires the
  backend to be running.
