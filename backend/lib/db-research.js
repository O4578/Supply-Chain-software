'use strict';

// Deterministic research over the existing SupplyChain Intelligence dataset.
// Used to (a) ground the AI in the user's real relationship graph and
// (b) produce a fully evidence-sourced report when no AI key is configured.

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(inc|inc\.|corp|corp\.|corporation|ltd|limited|plc|nv|sa|ag|se|holding|holdings|group|the)\b/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Fuzzy-match free text (e.g. "Who supplies NVIDIA?") against dataset companies.
function findCompaniesInText(text, companies) {
  const haystack = ` ${String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const matches = [];
  for (const company of companies) {
    const tokens = [company.name, company.name.replace(/\(.*?\)/g, '').trim(), (company.ticker || '').split('·')[0].trim()];
    for (const token of tokens) {
      const normalized = normalizeName(token);
      if (normalized.length >= 3 && haystack.includes(` ${normalized} `)) {
        matches.push(company);
        break;
      }
    }
  }
  return matches;
}

function matchCompanyByName(name, companies) {
  const target = normalizeName(name);
  if (!target) return null;
  for (const company of companies) {
    const candidates = [company.name, company.name.replace(/\(.*?\)/g, '').trim(), (company.ticker || '').split('·')[0].trim()];
    for (const candidate of candidates) {
      if (normalizeName(candidate) === target) return company;
    }
  }
  for (const company of companies) {
    const normalized = normalizeName(company.name);
    if (normalized && (target.includes(normalized) || normalized.includes(target))) return company;
  }
  return null;
}

// Build the compact graph context handed to the AI with every request.
function buildDbContext(db) {
  const companies = db.companies || [];
  const relationships = db.relationships || [];
  const byCompany = new Map(companies.map(company => [company.id, { suppliers: [], customers: [], partners: [], competitors: [] }]));
  for (const rel of relationships) {
    if (rel.type === 'supply') {
      const supplier = companies.find(company => company.id === rel.supplierId);
      const customer = companies.find(company => company.id === rel.customerId);
      if (supplier && byCompany.has(rel.customerId)) byCompany.get(rel.customerId).suppliers.push(`${supplier.name}: ${rel.product || 'unspecified product'} (evidence: ${rel.evidenceStatus || 'reference-only'}, ${rel.assessment || '?'} assessment)`);
      if (customer && byCompany.has(rel.supplierId)) byCompany.get(rel.supplierId).customers.push(`${customer.name}: ${rel.product || 'unspecified product'} (evidence: ${rel.evidenceStatus || 'reference-only'}, ${rel.assessment || '?'} assessment)`);
    } else if (rel.type === 'partner' || rel.type === 'competitor') {
      const a = companies.find(company => company.id === rel.companyA);
      const b = companies.find(company => company.id === rel.companyB);
      if (!a || !b) continue;
      if (byCompany.has(rel.companyA)) byCompany.get(rel.companyA)[rel.type === 'partner' ? 'partners' : 'competitors'].push(`${b.name}: ${rel.product || 'unspecified'}`);
      if (byCompany.has(rel.companyB)) byCompany.get(rel.companyB)[rel.type === 'partner' ? 'partners' : 'competitors'].push(`${a.name}: ${rel.product || 'unspecified'}`);
    }
  }
  return companies.map(company => ({
    id: company.id,
    name: company.name,
    ticker: company.ticker,
    country: company.country,
    industry: company.industry,
    connections: byCompany.get(company.id)
  }));
}

// Second-hop lookups: suppliers of suppliers / customers of customers.
function indirectRelationships(companyId, db, maxDepth = 2) {
  const companies = db.companies || [];
  const byId = new Map(companies.map(company => [company.id, company]));
  const supplyByCustomer = new Map();
  const supplyBySupplier = new Map();
  for (const rel of db.relationships || []) {
    if (rel.type !== 'supply') continue;
    if (!supplyByCustomer.has(rel.customerId)) supplyByCustomer.set(rel.customerId, []);
    if (!supplyBySupplier.has(rel.supplierId)) supplyBySupplier.set(rel.supplierId, []);
    supplyByCustomer.get(rel.customerId).push(rel);
    supplyBySupplier.get(rel.supplierId).push(rel);
  }
  const rows = [];
  const queue = [{ id: companyId, depth: 0, path: [companyId] }];
  const seen = new Set([companyId]);
  while (queue.length) {
    const current = queue.shift();
    if (current.depth >= maxDepth) continue;
    const upstream = supplyByCustomer.get(current.id) || [];
    const downstream = supplyBySupplier.get(current.id) || [];
    for (const rel of upstream) {
      const next = { rel, otherId: rel.supplierId, role: 'supplier', depth: current.depth + 1, path: [...current.path, rel.supplierId] };
      rows.push(next);
      if (!seen.has(next.otherId)) { seen.add(next.otherId); queue.push({ id: next.otherId, depth: next.depth, path: next.path }); }
    }
    for (const rel of downstream) {
      const next = { rel, otherId: rel.customerId, role: 'customer', depth: current.depth + 1, path: [...current.path, rel.customerId] };
      rows.push(next);
      if (!seen.has(next.otherId)) { seen.add(next.otherId); queue.push({ id: next.otherId, depth: next.depth, path: next.path }); }
    }
  }
  return rows.filter(row => byId.has(row.otherId));
}

const SOURCE_INDEX = { id: 0 };
function addSource(sources, source) {
  const key = source.url || source.title;
  const existing = sources.find(item => (item.url || item.title) === key);
  if (existing) return existing.id;
  const id = `db-${++SOURCE_INDEX.id}`;
  sources.push({ id, ...source });
  return id;
}

// Full offline report: only claims that exist in the user's dataset, with the
// dataset's own source records. Nothing is invented.
function databaseOnlyReport(question, mode, db) {
  const companies = db.companies || [];
  const sources = [];
  const targets = findCompaniesInText(question, companies);
  const primary = targets[0] || null;
  const rows = primary ? indirectRelationships(primary.id, db, 2) : [];
  const direct = rows.filter(row => row.depth === 1);
  const indirect = rows.filter(row => row.depth > 1);
  const byId = new Map(companies.map(company => [company.id, company]));

  const mentioned = targets.map(company => ({
    id: company.id,
    name: company.name,
    ticker: company.ticker,
    country: company.country,
    industry: company.industry,
    role: 'Research subject',
    directness: '—',
    evidence: 'reported',
    confidence: 'high',
    explanation: 'Matched in the existing SupplyChain Intelligence dataset.',
    sourceIds: []
  }));

  const companyEntries = direct.map(row => {
    const company = byId.get(row.otherId);
    const sourceId = row.rel.sourceId && db.sources?.[row.rel.sourceId]
      ? addSource(sources, {
          title: db.sources[row.rel.sourceId].title,
          publisher: db.sources[row.rel.sourceId].url ? new URL(db.sources[row.rel.sourceId].url).hostname.replace(/^www\./, '') : 'Dataset source',
          date: null,
          url: db.sources[row.rel.sourceId].url || null,
          verifies: db.sources[row.rel.sourceId].scope || row.rel.evidenceNote || `Verifies the ${byId.get(row.rel.supplierId)?.name || '?'} → ${byId.get(row.rel.customerId)?.name || '?'} relationship.`
        })
      : null;
    return {
      id: company.id,
      name: company.name,
      ticker: company.ticker,
      country: company.country,
      industry: company.industry,
      role: row.role === 'supplier' ? 'Supplier' : 'Customer',
      directness: 'Direct',
      evidence: row.rel.evidenceStatus === 'primary' || row.rel.evidenceStatus === 'official' ? 'confirmed' : 'reported',
      confidence: row.rel.assessment === 'H' ? 'high' : row.rel.assessment === 'M' ? 'medium' : 'low',
      explanation: `${company.name} → ${row.rel.product || 'unspecified product/service'} → ${primary?.name || 'subject'} (direction: ${row.role === 'supplier' ? 'supplies' : 'buys from'}).`,
      sourceIds: sourceId ? [sourceId] : [],
      inDatabase: true,
      dbId: company.id
    };
  });

  const indirectEntries = indirect.slice(0, 12).map(row => {
    const company = byId.get(row.otherId);
    const pathNames = row.path.map(id => byId.get(id)?.name || '?');
    return {
      id: company.id,
      name: company.name,
      ticker: company.ticker,
      country: company.country,
      industry: company.industry,
      role: row.role === 'supplier' ? 'Indirect supplier' : 'Indirect customer',
      directness: 'Indirect',
      evidence: 'inferred',
      confidence: 'low',
      explanation: `Derived from the dataset graph: ${pathNames.join(row.role === 'supplier' ? ' ← ' : ' → ')}. This is a graph dependency, not a disclosed contract.`,
      sourceIds: [],
      inDatabase: true,
      dbId: company.id
    };
  });

  const limitations = [];
  if (!primary) limitations.push('No company in the existing dataset matched the question, so a graph-based answer could not be built.');
  limitations.push('This report was generated from the curated local dataset only: the AI model and live web search are not configured (see the setup guide). Coverage is therefore limited to what is already recorded.');
  limitations.push('A company or relationship missing from the dataset is unknown, not absent.');
  if (sourceIdless(direct)) limitations.push('Some direct relationships come from inherited demo records without a specific citation; they are marked "reported" rather than "confirmed".');

  return {
    title: primary ? `Dataset research: ${primary.name}` : 'Dataset research',
    mode,
    executiveSummary: primary
      ? `The local dataset records ${direct.length} direct supply links involving ${primary.name}${targets.length > 1 ? ` (question also matched: ${targets.slice(1).map(company => company.name).join(', ')})` : ''} and ${indirect.length} indirect graph dependencies up to tier 2. ${direct.length ? 'Each link below carries the dataset\'s own source note.' : 'No direct supply links are recorded for this company yet.'} Configure an AI provider and a web-search API key to extend this analysis with live public-source research.`
      : 'No company from the existing dataset could be matched to this question. The offline (dataset-only) research mode cannot investigate companies outside the local database.',
    companies: [...mentioned, ...companyEntries, ...indirectEntries],
    relationships: rows.slice(0, 20).map(row => ({
      from: byId.get(row.rel.supplierId)?.name || '?',
      to: byId.get(row.rel.customerId)?.name || '?',
      via: row.rel.product || 'unspecified product/service',
      type: 'supply',
      evidence: row.rel.evidenceStatus === 'primary' || row.rel.evidenceStatus === 'official' ? 'confirmed' : 'reported',
      sourceIds: []
    })),
    investmentImplications: [],
    risks: collectRisks(primary, direct, byId),
    limitations,
    sources,
    missingInformation: ['Live web evidence was not collected because no search provider is configured.'],
    confidenceNote: 'Confidence values are inherited from the dataset\'s own H/M/L assessment labels; "inferred" entries are graph-derived, not disclosed.',
    subject: primary ? { name: primary.name, dbId: primary.id } : null
  };
}

function sourceIdless(rows) {
  return rows.some(row => !row.rel.evidenceStatus);
}

function collectRisks(primary, directRows, byId) {
  if (!primary) return [];
  const risks = [];
  const supplierCountries = [...new Set(directRows.filter(row => row.role === 'supplier').map(row => byId.get(row.otherId)?.country).filter(Boolean))];
  if (supplierCountries.length === 1) risks.push(`Geographic concentration: all recorded direct suppliers of ${primary.name} are based in ${supplierCountries[0]}.`);
  const unverified = directRows.filter(row => !row.rel.evidenceStatus).length;
  if (unverified) risks.push(`${unverified} recorded relationship(s) rely on general reference links rather than a specific filing or announcement.`);
  return risks;
}

module.exports = { findCompaniesInText, matchCompanyByName, buildDbContext, indirectRelationships, databaseOnlyReport };
