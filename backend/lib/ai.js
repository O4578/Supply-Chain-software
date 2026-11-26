'use strict';

// Configurable AI provider layer. All keys are read from environment variables
// (or a local .env file loaded by the server) and never sent to the frontend.

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function providerConfig() {
  const forced = env('AI_PROVIDER', '').toLowerCase();
  const candidates = {
    openai: {
      provider: 'openai',
      key: env('OPENAI_API_KEY', ''),
      baseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
      model: env('OPENAI_MODEL', 'gpt-4o-mini')
    },
    anthropic: {
      provider: 'anthropic',
      key: env('ANTHROPIC_API_KEY', ''),
      baseUrl: env('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
      model: env('ANTHROPIC_MODEL', 'claude-sonnet-4-20250514')
    },
    mistral: {
      provider: 'mistral',
      key: env('MISTRAL_API_KEY', ''),
      baseUrl: env('MISTRAL_BASE_URL', 'https://api.mistral.ai/v1'),
      model: env('MISTRAL_MODEL', 'mistral-large-latest')
    }
  };
  if (forced && candidates[forced]) {
    const config = candidates[forced];
    return config.key ? { ...config, configured: true } : { ...config, configured: false, error: `AI_PROVIDER is set to "${forced}" but its API key is missing.` };
  }
  for (const config of Object.values(candidates)) {
    if (config.key) return { ...config, configured: true };
  }
  return { provider: null, configured: false, key: '', model: null, baseUrl: null, error: 'No AI provider API key configured. Set OPENAI_API_KEY, ANTHROPIC_API_KEY or MISTRAL_API_KEY.' };
}

function timeoutSignal(ms) {
  return AbortSignal.timeout(ms);
}

async function chat({ system, user, maxTokens = 4096, temperature = 0.2, timeoutMs = 120000 }) {
  const config = providerConfig();
  if (!config.configured) {
    const error = new Error(config.error || 'No AI provider configured.');
    error.code = 'AI_NOT_CONFIGURED';
    throw error;
  }
  if (config.provider === 'anthropic') {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      signal: timeoutSignal(timeoutMs),
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: maxTokens,
        temperature,
        system,
        messages: [{ role: 'user', content: user }]
      })
    });
    if (!response.ok) throw new Error(`Anthropic API error ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const data = await response.json();
    const text = (data.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
    return { text, provider: 'anthropic', model: config.model };
  }
  // OpenAI-compatible (also covers Mistral and any OpenAI-style endpoint).
  const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal: timeoutSignal(timeoutMs),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.key}`
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: maxTokens,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });
  if (!response.ok) throw new Error(`AI API error ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const data = await response.json();
  const text = data.choices?.map(choice => choice.message?.content || '').join('\n') || '';
  return { text, provider: config.provider, model: config.model };
}

// Lenient JSON extraction: models sometimes wrap JSON in prose or code fences.
function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

module.exports = { providerConfig, chat, extractJson };
