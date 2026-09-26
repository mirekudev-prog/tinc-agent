/**
 * TINC API Caller — Smart retries, RPM pacing, empty-body recovery
 *
 * Design points (learned from real NVIDIA NIM + Groq behavior):
 * - 429s often return an EMPTY BODY → must retry, not "Unexpected end of JSON input"
 * - Free tiers: NVIDIA NIM = 40 RPM. All calls go through a shared rate meter
 *   so agent cycles pace themselves instead of hammering.
 * - Every failure surfaces exact HTTP status + body + attempt count (Anti-Flaw #6).
 */

import { PROVIDERS } from './config.js';

export const RETRY_DELAYS = [2000, 5000, 10000, 20000, 40000, 60000, 90000, 120000, 180000, 240000];

// ============================================================
// SHARED RATE METER — provider RPM budget, paced across calls
// ============================================================
// Every call records a timestamp. Before a new call, we ensure the
// rolling 60s window respects the provider's requests-per-minute
// budget, staying just under the documented limit.

const PROVIDER_RPM = {
  nvidia: 38,      // rated 40 RPM — stay just under
  groq: 28,        // rated 30 RPM
  mistral: 55,
  cerebras: 55,
  openrouter: 18   // conservative for free tier
};

const callLog = new Map(); // provider -> [timestamps]

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export async function waitForRpmSlot(provider) {
  const budget = PROVIDER_RPM[provider] || 30;
  const now = Date.now();
  const log = (callLog.get(provider) || []).filter(t => now - t < 60000);

  if (log.length >= budget) {
    const waitMs = (log[0] + 60050) - now;
    if (waitMs > 0) {
      console.log(`⏱  ${provider} RPM budget reached (${budget}/min) — pacing ${Math.ceil(waitMs / 1000)}s...`);
      await sleep(waitMs);
    }
  }

  const fresh = (callLog.get(provider) || []).filter(t => Date.now() - t < 60000);
  fresh.push(Date.now());
  callLog.set(provider, fresh);
}

// Minimum gap between consecutive calls to the same provider
const PROVIDER_MIN_GAP_MS = { nvidia: 1500, groq: 2000 };
const lastCallAt = new Map();

async function enforceMinGap(provider) {
  const gap = PROVIDER_MIN_GAP_MS[provider] || 500;
  const last = lastCallAt.get(provider) || 0;
  const elapsed = Date.now() - last;
  if (elapsed < gap && elapsed >= 0) {
    await sleep(gap - elapsed);
  }
  lastCallAt.set(provider, Date.now());
}

export function getRateStatus(provider) {
  const budget = PROVIDER_RPM[provider] || 30;
  const now = Date.now();
  const log = (callLog.get(provider) || []).filter(t => now - t < 60000);
  return { used: log.length, budget, provider };
}

// ============================================================
// RETRY WRAPPER
// ============================================================

export async function callLLMWithRetry(llmCall, options = {}) {
  const {
    maxAttempts = 10,
    onRetry = (attempt, delay, error) => console.log(`⏳ Retry ${attempt}/${maxAttempts} in ${Math.round(delay / 1000)}s: ${error.message}`),
    abortSignal
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (abortSignal?.aborted) {
        throw new Error('Aborted');
      }

      const result = await llmCall();
      if (attempt > 1) {
        console.log(`✅ Request succeeded on attempt ${attempt}`);
      }
      return result;

    } catch (error) {
      lastError = error;

      const isRetryable = error.status === 429
        || (typeof error.status === 'number' && error.status >= 500)
        || error.code === 'ECONNRESET'
        || error.code === 'ETIMEDOUT'
        || error.retryable === true; // empty/malformed body — transient upstream issue

      if (!isRetryable || attempt === maxAttempts) {
        console.error(`❌ LLM call failed after ${attempt} attempt(s). Status: ${error.status || 'n/a'} — ${error.message}`);
        throw error;
      }

      // Server told us exactly how long to wait? Honor it.
      let delay = RETRY_DELAYS[attempt - 1] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
      const serverWait = error.retryAfterMs;
      if (serverWait && serverWait > delay) {
        delay = Math.min(serverWait + 500, 300000);
      }

      onRetry(attempt, delay, error);
      await sleep(delay);
    }
  }

  throw lastError;
}

export async function rateLimitedSleep(ms, abortSignal) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        clearTimeout(timeout);
        reject(new Error('Aborted'));
      }, { once: true });
    }
  });
}

// ============================================================
// URL RESOLUTION
// ============================================================

export function resolveBaseUrl(provider, customProviders = {}) {
  if (provider.startsWith('custom:')) {
    const cp = customProviders[provider.slice(7)];
    return cp ? cp.baseUrl : null;
  }
  return PROVIDERS[provider]?.baseUrl || null;
}

// ============================================================
// REAL LLM API CALL
// ============================================================

/**
 * Call the LLM API with the given messages and tools.
 * Returns { content, tool_calls, finish_reason } parsed from the OpenAI-compatible response.
 */
export async function callLLMApi(messages, toolsList, provider, model, apiKey, customProviders = {}) {
  const baseUrl = resolveBaseUrl(provider, customProviders);
  if (!baseUrl) {
    throw new Error(`Unknown provider: ${provider}. Available: ${Object.keys(PROVIDERS).join(', ')}, custom:<name>`);
  }
  if (!model) {
    throw new Error('No model selected. Use /model to set one.');
  }
  if (!apiKey) {
    throw new Error(`No API key for ${provider}. Re-run the setup wizard (delete ~/.tinc/tinc_config.json) or set the env var.`);
  }

  // Pace: RPM budget + min-gap before firing
  await waitForRpmSlot(provider);
  await enforceMinGap(provider);

  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  console.log(`\n🤖 ${provider}/${model}...`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      model: model,
      messages: messages,
      // Full OpenAI tool format — the {type:'function'} wrapper is REQUIRED
      tools: toolsList.length > 0 ? toolsList : undefined,
      temperature: 0.7,
      max_tokens: 4096
    }),
    signal: AbortSignal.timeout(180000)
  }).catch(err => {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      const e = new Error('Request timed out after 180s');
      e.code = 'ETIMEDOUT';
      throw e;
    }
    throw err;
  });

  const statusCode = response.status;

  // ---- Error path: capture body once, classify, honor Retry-After ----
  if (!response.ok) {
    let errorBody = '';
    try {
      errorBody = await response.text();
    } catch {}

    const error = new Error(`LLM API error: ${statusCode} ${response.statusText}${errorBody ? ' — ' + errorBody.slice(0, 500) : ''}`);
    error.status = statusCode;

    // Honor server Retry-After header
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const secs = parseFloat(retryAfter);
      if (!isNaN(secs)) error.retryAfterMs = secs * 1000;
    }
    // Groq-style "Please try again in 16.9s" embedded in the body
    const bodyMatch = errorBody && errorBody.match(/try again in ([\d.]+)s/i);
    if (bodyMatch) {
      const secs = parseFloat(bodyMatch[1]);
      if (!isNaN(secs)) error.retryAfterMs = Math.max(error.retryAfterMs || 0, secs * 1000);
    }

    // 429 with empty body is STILL a rate limit — retryable + visible
    if (statusCode === 429 && !errorBody) {
      error.message = `LLM API error: 429 Too Many Requests (empty body from ${provider})`;
    }
    throw error;
  }

  // ---- Success path: empty/malformed body must retry, not crash ----
  let data;
  try {
    data = await response.json();
  } catch (parseError) {
    const e = new Error(`Malformed/empty response body from ${provider} (HTTP ${statusCode}): ${parseError.message}`);
    e.status = statusCode;
    e.retryable = true; // transient upstream truncation
    throw e;
  }

  const choice = data.choices?.[0];
  if (!choice) {
    const e = new Error(`Unexpected response format: no choices found. Raw: ${JSON.stringify(data).slice(0, 300)}`);
    e.status = statusCode;
    e.retryable = true;
    throw e;
  }

  const message = choice.message;
  const finishReason = choice.finish_reason;
  const content = message.content || '';

  // ACTUAL usage from the provider — real numbers, not estimates
  const usage = {
    promptTokens: data.usage?.prompt_tokens ?? null,
    completionTokens: data.usage?.completion_tokens ?? null,
    totalTokens: data.usage?.total_tokens ?? null
  };

  let tool_calls = [];
  if (Array.isArray(message.tool_calls)) {
    tool_calls = message.tool_calls.map(tc => ({
      id: tc.id,
      type: tc.type,
      function: {
        name: tc.function?.name || '',
        arguments: tc.function?.arguments || '{}'
      }
    }));
  }

  console.log(`✅ Response (finish: ${finishReason})${content ? ' — ' + content.slice(0, 80) + (content.length > 80 ? '...' : '') : ', ' + tool_calls.length + ' tool call(s)'}`);

  return {
    content,
    tool_calls,
    finish_reason: finishReason,
    usage
  };
}
