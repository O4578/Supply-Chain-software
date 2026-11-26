'use strict';

// Live web research: pluggable search providers (API-key based) plus two
// keyless primary-source channels (SEC EDGAR full-text search, direct page
// retrieval). Every result keeps its URL, publisher and date so the AI can
// only cite evidence that actually exists.

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function searchProviders() {
  const providers = [];
  if (env('TAVILY_API_KEY', '')) providers.push('tavily');
  if (env('BRAVE_API_KEY', '')) providers.push('brave');
  if (env('GOOGLE_API_KEY', '') && env('GOOGLE_CSE_ID', '')) providers.push('google');
  if (env('SERPAPI_KEY', '')) providers.push('serpapi');
  providers.push('edgar');
  return providers;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

function truncate(text, max = 4500) {
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated]`;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function publisherFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Unknown publisher';
  }
}

async function searchTavily(query, apiKey, limit) {
  const response = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: limit, search_depth: 'advanced', include_answer: false })
  });
  if (!response.ok) throw new Error(`Tavily error ${response.status}`);
  const data = await response.json();
  return (data.results || []).map(result => ({
    title: result.title || 'Untitled result',
    url: result.url,
    publisher: publisherFromUrl(result.url),
    date: result.published_date || null,
    snippet: truncate(result.content || '', 900),
    content: truncate(result.content || '', 3500),
    sourceKind: 'web'
  }));
}

async function searchBrave(query, apiKey, limit) {
  const response = await fetchWithTimeout(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`, {
    headers: { 'x-subscription-token': apiKey, accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`Brave error ${response.status}`);
  const data = await response.json();
  return (data.web?.results || []).map(result => ({
    title: result.title || 'Untitled result',
    url: result.url,
    publisher: publisherFromUrl(result.url),
    date: result.age || null,
    snippet: truncate(result.description || '', 900),
    content: truncate(result.description || '', 1500),
    sourceKind: 'web'
  }));
}

async function searchGoogle(query, limit) {
  const key = env('GOOGLE_API_KEY', '');
  const cseId = env('GOOGLE_CSE_ID', '');
  const response = await fetchWithTimeout(`https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cseId)}&num=${limit}&q=${encodeURIComponent(query)}`);
  if (!response.ok) throw new Error(`Google CSE error ${response.status}`);
  const data = await response.json();
  return (data.items || []).map(item => ({
    title: item.title || 'Untitled result',
    url: item.link,
    publisher: publisherFromUrl(item.link),
    date: null,
    snippet: truncate(item.snippet || '', 900),
    content: truncate(item.snippet || '', 1500),
    sourceKind: 'web'
  }));
}

async function searchSerpApi(query, limit) {
  const key = env('SERPAPI_KEY', '');
  const response = await fetchWithTimeout(`https://serpapi.com/search.json?engine=google&num=${limit}&q=${encodeURIComponent(query)}&api_key=${encodeURIComponent(key)}`);
  if (!response.ok) throw new Error(`SerpApi error ${response.status}`);
  const data = await response.json();
  return (data.organic_results || []).map(item => ({
    title: item.title || 'Untitled result',
    url: item.link,
    publisher: publisherFromUrl(item.link),
    date: item.date || null,
    snippet: truncate(item.snippet || '', 900),
    content: truncate(item.snippet || '', 1500),
    sourceKind: 'web'
  }));
}

// SEC EDGAR full-text search: keyless, official regulatory-filing evidence.
// Requires a descriptive User-Agent per SEC fair-access policy.
async function searchEdgar(query, limit = 6) {
  const userAgent = env('SEC_USER_AGENT', 'SupplyChain-Intelligence-Research research@example.com');
  const response = await fetchWithTimeout(
    `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${query.replace(/"/g, ' ')}"`)}&forms=10-K,10-Q,20-F,8-K`,
    { headers: { 'user-agent': userAgent, accept: 'application/json' } },
    12000
  );
  if (!response.ok) throw new Error(`EDGAR error ${response.status}`);
  const data = await response.json();
  return (data.hits?.hits || []).slice(0, limit).map(hit => {
    const source = hit._source || {};
    const cik = source.cik || hit._id?.split(':')[0];
    const accession = source.adsh || source.file_date || '';
    const link = accession
      ? `https://www.sec.gov/Archives/edgar/data/${String(cik).padStart(10, '0')}/${accession.replace(/-/g, '')}/${source.file_name || ''}`
      : `https://www.sec.gov/edgar/search/?q=${encodeURIComponent(query)}`;
    const excerpt = hit.highlight && hit.highlight._source
      ? Object.values(hit.highlight._source).flat().join(' … ')
      : '';
    return {
      title: `${source.display_names?.[0] || source.company || 'SEC filer'} — ${source.file_type || 'filing'} (${source.file_date || 'date unknown'})`,
      url: link,
      publisher: 'SEC EDGAR',
      date: source.file_date || null,
      snippet: truncate(stripHtml(excerpt || source.file_description || ''), 700),
      content: truncate(stripHtml(excerpt), 2000),
      sourceKind: 'regulatory'
    };
  });
}

// One search fan-out across every configured provider. Provider failures are
// collected as warnings; they never abort the whole research request.
async function runSearch(queries, { limitPerQuery = 5 } = {}) {
  const warnings = [];
  const used = [];
  const byUrl = new Map();

  const apiKeyProviders = [];
  if (env('TAVILY_API_KEY', '')) apiKeyProviders.push(['tavily', query => searchTavily(query, env('TAVILY_API_KEY', ''), limitPerQuery)]);
  if (env('BRAVE_API_KEY', '')) apiKeyProviders.push(['brave', query => searchBrave(query, env('BRAVE_API_KEY', ''), limitPerQuery)]);
  if (env('GOOGLE_API_KEY', '') && env('GOOGLE_CSE_ID', '')) apiKeyProviders.push(['google', query => searchGoogle(query, limitPerQuery)]);
  if (env('SERPAPI_KEY', '')) apiKeyProviders.push(['serpapi', query => searchSerpApi(query, limitPerQuery)]);

  const tasks = [];
  for (const query of queries.slice(0, 8)) {
    if (apiKeyProviders.length) {
      const [name, run] = apiKeyProviders[0];
      tasks.push(run(query).then(results => {
        used.push(name);
        for (const result of results) if (result.url && !byUrl.has(result.url)) byUrl.set(result.url, result);
      }).catch(error => warnings.push(`Search provider "${name}" failed for "${query}": ${error.message}`)));
    } else {
      warnings.push(`No web-search API key configured (set TAVILY_API_KEY, BRAVE_API_KEY, GOOGLE_API_KEY+GOOGLE_CSE_ID or SERPAPI_KEY); only SEC EDGAR was used for "${query}".`);
    }
    tasks.push(searchEdgar(query, 4).then(results => {
      if (results.length) used.push('edgar');
      for (const result of results) if (result.url && !byUrl.has(result.url)) byUrl.set(result.url, result);
    }).catch(error => warnings.push(`SEC EDGAR search failed for "${query}": ${error.message}`)));
  }

  await Promise.allSettled(tasks);
  return { results: [...byUrl.values()], warnings, providersUsed: [...new Set(used)] };
}

// Retrieve readable text from a handful of the most promising pages so the
// model reasons over real content rather than snippets alone.
async function fetchPages(results, { max = 4, timeoutMs = 12000 } = {}) {
  const warnings = [];
  const priority = [...results].sort((a, b) => (a.sourceKind === 'regulatory' ? -1 : 0) - (b.sourceKind === 'regulatory' ? -1 : 0));
  await Promise.allSettled(priority.slice(0, max).map(async result => {
    if (result.content && result.content.length > 800) return;
    try {
      const response = await fetchWithTimeout(result.url, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; SupplyChainIntelligence/1.0; research assistant)' }
      }, timeoutMs);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('html') && !contentType.includes('text')) return;
      const text = stripHtml(await response.text());
      if (text.length > 400) result.content = truncate(text, 4500);
    } catch (error) {
      warnings.push(`Could not retrieve page content from ${result.publisher}: ${error.message}`);
    }
  }));
  return warnings;
}

module.exports = { runSearch, fetchPages, searchProviders, stripHtml, truncate };
