/**
 * TINC API Caller - Smart retries + real LLM calls
 * Handles rate limits and transient errors gracefully.
 * Supports all built-in providers + custom OpenAI-compatible endpoints.
 */

import { PROVIDERS } from './config.js';

export const RETRY_DELAYS = [2000, 5000, 10000, 20000, 40000, 60000, 90000, 120000, 180000, 240000]; // 10 attempts max

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
        || error.code === 'ETIMEDOUT';

      if (!isRetryable || attempt === maxAttempts) {
        // LOUD ERRORS (Anti-Flaw #6): exact status + message + attempt count
        console.error(`❌ LLM call failed after ${attempt} attempt(s). Status: ${error.status || 'n/a'} — ${error.message}`);
        throw error;
      }

      const delay = RETRY_DELAYS[attempt - 1] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
      onRetry(attempt, delay, error);

      await sleep(delay, abortSignal);
    }
  }

  throw lastError;
}

export async function sleep(ms, abortSignal) {
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

// ---------- URL RESOLUTION ----------

export function resolveBaseUrl(provider, customProviders = {}) {
  if (provider.startsWith('custom:')) {
    const cp = customProviders[provider.slice(7)];
    return cp ? cp.baseUrl : null;
  }
  return PROVIDERS[provider]?.baseUrl || null;
}

// ---------- REAL LLM API CALL ----------

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

  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  console.log(`\n🤖 ${provider}/${model}...`);

  // 3-minute hard timeout per call
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

  if (!response.ok) {
    let errorBody = '';
    try {
      errorBody = await response.text();
    } catch {}
    const error = new Error(`LLM API error: ${statusCode} ${response.statusText}${errorBody ? ' — ' + errorBody.slice(0, 500) : ''}`);
    error.status = statusCode;
    throw error;
  }

  const data = await response.json();

  const choice = data.choices?.[0];
  if (!choice) {
    throw new Error(`Unexpected response format: no choices found. Raw: ${JSON.stringify(data).slice(0, 300)}`);
  }

  const message = choice.message;
  const finishReason = choice.finish_reason;
  const content = message.content || '';

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
    finish_reason: finishReason
  };
}
