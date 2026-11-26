'use strict';

const { providerConfig, chat, extractJson } = require('./ai');
const { runSearch, fetchPages } = require('./search');
const { buildDbContext, findCompaniesInText, matchCompanyByName, databaseOnlyReport } = require('./db-research');

const RESEARCH_MODES = ['supply-chain', 'company', 'investment', 'risk', 'competitor', 'industry', 'auto'];

// ---------------------------------------------------------------------------
// Step 1: planning call — turn the question into a concrete research plan.
// ---------------------------------------------------------------------------
async function planResearch(question, mode, db) {
  const context = buildDbContext(db);
  const knownCompanies = context.map(company => `${company.name} (${company.ticker}, ${company.country}; ${company.industry})`).join('; ');
  const system = `You are the research planner of an institutional supply-chain intelligence platform. You return ONLY valid JSON, no prose.`;
  const user = `User question: "${question}"
Selected research mode: ${mode || 'auto'} (one of ${RESEARCH_MODES.join(', ')}).

Companies already in the database: ${knownCompanies}

Return JSON exactly in this shape:
{
  "mode": "<best-fit mode from the list>",
  "subjectCompany": "<name or null>",
  "subjectInDatabase": "<db id if it matches a database company, else null>",
  " clarifications": omitted,
  "assumptions": ["<any assumption you must make>"],
  "searchQueries": ["<5-8 precise web search queries that would surface primary-source evidence: filings, supplier lists, press releases, contract announcements>"]
}
Rules: never treat a commercial relationship as a fact here; this step only plans where to look. Queries should target filings (10-K, 20-F, annual reports), official press releases and credible financial media.`;
  const { text, provider, model } = await chat({ system, user, maxTokens: 900, temperature: 0.1, timeoutMs: 45000 });
  const plan = extractJson(text);
  if (!plan || !Array.isArray(plan.searchQueries) || !plan.searchQueries.length) {
    throw new Error('The AI planner did not return a usable research plan.');
  }
  return {
    mode: RESEARCH_MODES.includes(plan.mode) ? plan.mode : (mode && RESEARCH_MODES.includes(mode) ? mode : 'auto'),
    subject: plan.subjectCompany || null,
    subjectDbId: plan.subjectInDatabase || null,
    assumptions: Array.isArray(plan.assumptions) ? plan.assumptions : [],
    queries: plan.searchQueries.filter(query => typeof query === 'string').slice(0, 8),
    provider, model
  };
}

// ---------------------------------------------------------------------------
// Step 4: synthesis call — the actual analyst report, grounded in evidence.
// ---------------------------------------------------------------------------
const REPORT_SCHEMA = `{
  "title": "short report title",
  "executiveSummary": "3-6 sentence direct answer to the question",
  "companies": [
    {
      "name": "", "ticker": "", "exchange": "", "country": "", "industry": "",
      "role": "supplier | customer | partner | competitor | candidate-beneficiary | other",
      "relationship": "short description of the relationship to the subject",
      "products": "products or services involved",
      "directness": "direct | indirect | unknown",
      "evidence": "confirmed | reported | inferred | unknown",
      "confidence": "high | medium | low",
      "inDatabase": true|false,
      "dbId": "<db company id if inDatabase else null>",
      "explanation": "exactly how this company is connected, e.g. 'TSMC → manufactures advanced semiconductor wafers → NVIDIA'; say whether it is directly disclosed, media-reported or inferred",
      "investmentNote": "why this company may or may not benefit commercially; distinguish disclosed revenue exposure from indirect benefit; empty string if not relevant",
      "sourceIds": ["s1", "s2"]
    }
  ],
  "relationships": [
    { "from": "Company A", "to": "Company B", "via": "product/service", "type": "supply | partner | competitor", "evidence": "confirmed | reported | inferred | unknown", "sourceIds": ["s1"] }
  ],
  "investmentImplications": ["<implication bullets>"],
  "risks": ["<risk bullets: concentration, single-source, geographic, export controls, tariffs>"],
  "limitations": ["<what is missing, unverified or uncertain>"],
  "missingInformation": ["<specific gaps>"],
  "confidenceNote": "one-paragraph overall confidence statement",
  "sources": [
    { "id": "s1", "title": "", "publisher": "", "date": "YYYY-MM-DD or null", "url": "", "verifies": "what exactly this source verifies" }
  ]
}`;

async function synthesizeReport({ question, mode, plan, db, evidence }) {
  const dbContext = buildDbContext(db);
  const evidenceText = evidence.map((item, index) => {
    return `[E${index}] title: ${item.title}
publisher: ${item.publisher} | date: ${item.date || 'unknown'} | url: ${item.url}
snippet: ${item.snippet || ''}
content: ${item.content || '(no page content retrieved)'}`;
  }).join('\n\n---\n\n');

  const system = `You are a senior financial research analyst producing institutional-grade supply-chain intelligence reports.
Non-negotiable accuracy rules:
1. Never invent supplier or customer relationships. Never invent citations, URLs or quotations.
2. A relationship may only be stated if it appears in the DATABASE CONTEXT or in the EVIDENCE block below.
3. Classify every relationship: "confirmed" (primary/official source: filing, company disclosure, regulator), "reported" (credible media), "inferred" (your reasoning, must say so), or "unknown".
4. Distinguish historical from currently active relationships when the evidence shows a date.
5. Never interpret missing public information as proof that a relationship does not exist; say "not publicly disclosed" instead.
6. If evidence is insufficient to answer, say so explicitly and report what would be needed.
7. Every company you list must carry sourceIds pointing ONLY to ids of sources you include in "sources", and every source must be a real item from the EVIDENCE block (use its exact URL) or a DATABASE CONTEXT source id prefixed "db:".
8. When a company appears in DATABASE CONTEXT with a db id, set inDatabase=true and dbId; otherwise inDatabase=false and dbId=null. Never guess db ids.
Return ONLY valid JSON matching the requested schema, no markdown fences, no commentary.`;

  const user = `USER QUESTION: "${question}"
RESEARCH MODE: ${mode}
PLANNER NOTES: subject=${plan.subject || 'n/a'}; assumptions=${JSON.stringify(plan.assumptions)}

DATABASE CONTEXT (the user's verified relationship dataset; cite as "db:<id>" only via these connection notes):
${JSON.stringify(dbContext, null, 1)}

EVIDENCE (live web/EDGAR results collected just now; cite by bracket id [E{n}] → include the source in "sources" with its exact url):
${evidenceText || '(no live evidence retrieved — say so in limitations and rely only on DATABASE CONTEXT, marking everything appropriately)'}

Produce the report as JSON with exactly this schema:
${REPORT_SCHEMA}

Additional requirements:
- "companies" must include all relevant companies discovered (aim for breadth, but every entry must be evidence-backed per the rules above).
- For supply-chain questions, cover suppliers AND customers/downstream channels where disclosed, including indirect (tier-2+) relationships that the evidence supports.
- Mark each company's "directness" honestly: only "direct" when the evidence describes a direct commercial relationship with the subject.
- Put citation ids next to the claims they support: use sourceIds on companies and relationships, and explain in "verifies" what each source proves.
- Set "confidence" per company: high only for confirmed primary-source relationships.`;

  const { text, provider, model } = await chat({ system, user, maxTokens: 6000, temperature: 0.2, timeoutMs: 150000 });
  const report = extractJson(text);
  if (!report || !Array.isArray(report.companies)) {
    throw new Error('The AI model did not return a usable structured report.');
  }
  return { report, provider, model };
}

function normalizeForMatch(value) {
  return String(value || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Post-filter: drop hallucinated citations, coerce enums, verify db ids.
function sanitizeReport(report, evidence, db) {
  const dbCompanyIds = new Set((db.companies || []).map(company => company.id));
  const evidenceUrls = new Set(evidence.map(item => item.url));
  const dbSourceIds = new Set(Object.keys(db.sources || {}));

  const referencedRawIds = new Set();
  for (const company of Array.isArray(report.companies) ? report.companies : []) {
    for (const id of Array.isArray(company.sourceIds) ? company.sourceIds : []) referencedRawIds.add(id);
  }
  for (const rel of Array.isArray(report.relationships) ? report.relationships : []) {
    for (const id of Array.isArray(rel.sourceIds) ? rel.sourceIds : []) referencedRawIds.add(id);
  }

  const sources = [];
  const seenUrls = new Set();
  for (const source of Array.isArray(report.sources) ? report.sources : []) {
    if (!source || typeof source !== 'object') continue;
    const url = typeof source.url === 'string' ? source.url : '';
    const rawId = typeof source.id === 'string' ? source.id : '';
    const isEvidence = url && evidenceUrls.has(url);
    const dbId = rawId.startsWith('db:') ? rawId.slice(3) : rawId;
    const dbSource = dbSourceIds.has(dbId) ? (db.sources || {})[dbId] : null;
    if (!isEvidence && !dbSource) continue; // drop invented citations
    if (url && seenUrls.has(url)) continue;
    if (url && !/^https?:\/\//.test(url)) continue;
    seenUrls.add(url);
    sources.push({
      id: rawId || `s${sources.length + 1}`,
      title: String(source.title || dbSource?.title || 'Untitled source').slice(0, 200),
      publisher: String(source.publisher || (dbSource?.url ? new URL(dbSource.url).hostname.replace(/^www\./, '') : 'Unknown')).slice(0, 100),
      date: source.date ? String(source.date).slice(0, 40) : null,
      url: url || dbSource?.url || null,
      verifies: String(source.verifies || dbSource?.scope || '').slice(0, 400)
    });
  }
  const sourceIds = new Set(sources.map(source => source.id));

  const cleanEnum = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
  const companies = (Array.isArray(report.companies) ? report.companies : []).slice(0, 40).map(company => ({
    name: String(company.name || 'Unknown company').slice(0, 120),
    ticker: company.ticker ? String(company.ticker).slice(0, 60) : null,
    exchange: company.exchange ? String(company.exchange).slice(0, 80) : null,
    country: company.country ? String(company.country).slice(0, 80) : null,
    industry: company.industry ? String(company.industry).slice(0, 160) : null,
    role: cleanEnum(company.role, ['supplier', 'customer', 'partner', 'competitor', 'candidate-beneficiary', 'other'], 'other'),
    relationship: String(company.relationship || '').slice(0, 300),
    products: company.products ? String(company.products).slice(0, 300) : null,
    directness: cleanEnum(company.directness, ['direct', 'indirect', 'unknown'], 'unknown'),
    evidence: cleanEnum(company.evidence, ['confirmed', 'reported', 'inferred', 'unknown'], 'unknown'),
    confidence: cleanEnum(company.confidence, ['high', 'medium', 'low'], 'low'),
    inDatabase: company.inDatabase === true || (!!company.dbId && dbCompanyIds.has(company.dbId)),
    dbId: dbCompanyIds.has(company.dbId) ? company.dbId : null,
    explanation: String(company.explanation || '').slice(0, 700),
    investmentNote: company.investmentNote ? String(company.investmentNote).slice(0, 600) : null,
    sourceIds: (Array.isArray(company.sourceIds) ? company.sourceIds : []).filter(id => typeof id === 'string').slice(0, 12)
  })).filter(company => company.name && company.name !== 'Unknown company');

  // A claimed db id is only honored when the company name actually matches
  // that database record, so a model cannot borrow another company's identity.
  for (const company of companies) {
    if (!company.dbId) { company.inDatabase = false; continue; }
    const record = (db.companies || []).find(entry => entry.id === company.dbId);
    const matches = record && [record.name, (record.ticker || '').split('·')[0].trim()]
      .some(candidate => normalizeForMatch(candidate) === normalizeForMatch(company.name));
    if (!matches) { company.dbId = null; company.inDatabase = false; }
  }

  // Auto-resolve db:<id> citations that the model referenced but did not list.
  for (const id of referencedRawIds) {
    if (!id.startsWith('db:') || sourceIds.has(id)) continue;
    const dbSource = (db.sources || {})[id.slice(3)];
    if (!dbSource) continue;
    const url = dbSource.url && /^https?:\/\//.test(dbSource.url) ? dbSource.url : null;
    if (url && seenUrls.has(url)) continue;
    if (url) seenUrls.add(url);
    sources.push({
      id,
      title: String(dbSource.title || 'Dataset source').slice(0, 200),
      publisher: url ? new URL(url).hostname.replace(/^www\./, '') : 'Dataset source',
      date: null,
      url,
      verifies: String(dbSource.scope || '').slice(0, 400)
    });
    sourceIds.add(id);
  }

  // Keep only citations that resolved to real evidence or dataset sources.
  for (const company of companies) company.sourceIds = company.sourceIds.filter(id => sourceIds.has(id));

  // Defense in depth: a claim whose citations were all dropped can no longer
  // present itself as confirmed or reported.
  for (const company of companies) {
    if (!company.sourceIds.length && (company.evidence === 'confirmed' || company.evidence === 'reported')) {
      company.evidence = 'inferred';
      company.confidence = 'low';
    }
  }

  const relationships = (Array.isArray(report.relationships) ? report.relationships : []).slice(0, 40).map(rel => ({
    from: String(rel.from || '').slice(0, 120),
    to: String(rel.to || '').slice(0, 120),
    via: rel.via ? String(rel.via).slice(0, 200) : null,
    type: cleanEnum(rel.type, ['supply', 'partner', 'competitor'], 'supply'),
    evidence: cleanEnum(rel.evidence, ['confirmed', 'reported', 'inferred', 'unknown'], 'unknown'),
    sourceIds: (Array.isArray(rel.sourceIds) ? rel.sourceIds : []).filter(id => typeof id === 'string').slice(0, 12)
  })).filter(rel => rel.from && rel.to);

  for (const rel of relationships) rel.sourceIds = rel.sourceIds.filter(id => sourceIds.has(id));
  for (const rel of relationships) {
    if (!rel.sourceIds.length && (rel.evidence === 'confirmed' || rel.evidence === 'reported')) {
      rel.evidence = 'inferred';
    }
  }

  const stringList = value => (Array.isArray(value) ? value : []).map(item => String(item).slice(0, 500)).filter(Boolean).slice(0, 15);

  return {
    title: String(report.title || 'Research report').slice(0, 200),
    executiveSummary: String(report.executiveSummary || '').slice(0, 4000),
    companies,
    relationships,
    investmentImplications: stringList(report.investmentImplications),
    risks: stringList(report.risks),
    limitations: stringList(report.limitations),
    missingInformation: stringList(report.missingInformation),
    confidenceNote: report.confidenceNote ? String(report.confidenceNote).slice(0, 1500) : null,
    sources
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
async function conductResearch(question, mode, db) {
  const started = Date.now();
  const warnings = [];
  const aiConfig = providerConfig();

  // Offline / dataset-only mode keeps the feature functional without any keys,
  // using only claims that already exist in the user's own dataset.
  if (!aiConfig.configured) {
    const report = databaseOnlyReport(question, mode || 'auto', db);
    return {
      report,
      meta: {
        engine: 'dataset-only',
        provider: null, model: null,
        searchProviders: [], evidenceCount: 0,
        cached: false, tookMs: Date.now() - started,
        warnings: [
          'No AI provider is configured: this report was built deterministically from the local dataset only. See the setup guide to enable live AI research.',
          ...report.limitations
        ],
        stages: { understand: true, identify: true, search: false, verify: true, analyze: true, report: true }
      }
    };
  }

  // Step 1 — understand & plan.
  let plan;
  try {
    plan = await planResearch(question, mode, db);
  } catch (error) {
    error.step = 'understanding-question';
    throw error;
  }
  warnings.push(...plan.assumptions.map(assumption => `Planner assumption: ${assumption}`));

  // Step 2 — database lookup (targets + graph context already in db payload).
  const dbMatches = findCompaniesInText(question, db.companies || []);
  if (plan.subject && !dbMatches.length) {
    const matched = matchCompanyByName(plan.subject, db.companies || []);
    if (matched) dbMatches.push(matched);
  }

  // Step 3 — live web + EDGAR evidence collection.
  const queries = [...plan.queries];
  if (plan.subject && !queries.some(query => query.toLowerCase().includes(plan.subject.toLowerCase()))) {
    queries.unshift(`${plan.subject} suppliers 10-K annual report`);
  }
  const search = await runSearch(queries);
  warnings.push(...search.warnings);
  const pageWarnings = await fetchPages(search.results);
  warnings.push(...pageWarnings);

  // Step 4 — grounded synthesis.
  let synthesis;
  try {
    synthesis = await synthesizeReport({ question, mode: plan.mode, plan, db, evidence: search.results });
  } catch (error) {
    error.step = 'analyzing-findings';
    throw error;
  }
  const report = sanitizeReport(synthesis.report, search.results, db);
  if (!search.results.length) {
    report.limitations.unshift('No live evidence could be retrieved during this run (search providers failed or are not configured). Claims rest on the local dataset and the model\'s stated reasoning only; treat unconfirmed entries with caution.');
  }

  return {
    report,
    meta: {
      engine: 'ai-research',
      provider: synthesis.provider,
      model: synthesis.model,
      searchProviders: search.providersUsed,
      evidenceCount: search.results.length,
      dbMatches: dbMatches.map(company => ({ id: company.id, name: company.name })),
      cached: false,
      tookMs: Date.now() - started,
      warnings,
      stages: {
        understand: true, identify: true,
        search: search.providersUsed.length > 0,
        verify: true, analyze: true, report: true
      }
    }
  };
}

module.exports = { conductResearch, RESEARCH_MODES };
