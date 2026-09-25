/**
 * TINC API Caller - Smart retries + real LLM calls
 * Handles rate limits and transient errors gracefully
 */

export const RETRY_DELAYS = [2000, 5000, 10000, 20000, 40000, 60000, 90000, 120000, 180000, 240000]; // 10 attempts max

export async function callLLMWithRetry(llmCall, options = {}) {
  const { 
    maxAttempts = 10, 
    onRetry = (attempt, delay, error) => console.log(`⏳ Retry ${attempt}/${maxAttempts} in ${delay/1000}s: ${error.message}`),
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
      
      // Check if we should retry
      const isRetryable = error.status === 429 || error.status >= 500 || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT';
      
      if (!isRetryable || attempt === maxAttempts) {
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
      });
    }
  });
}

/**
 * Chunk large content into manageable pieces for API processing
 */
export function chunkContent(content, maxChunkSize = 8000) {
  if (content.length <= maxChunkSize) {
    return [content];
  }
  
  const chunks = [];
  let start = 0;
  
  while (start < content.length) {
    let end = Math.min(start + maxChunkSize, content.length);
    if (end < content.length) {
      const lastNewline = content.lastIndexOf('\n', end);
      if (lastNewline > start) {
        end = lastNewline + 1;
      }
    }
    chunks.push(content.slice(start, end));
    start = end;
  }
  
  return chunks;
}

/**
 * Process large content in chunks with rate limit awareness
 */
export async function processInChunks(content, processFn, options = {}) {
  const { 
    maxChunkSize = 8000,
    delayBetweenChunks = 1000,
    onChunk = (index, total, result) => console.log(`📦 Chunk ${index + 1}/${total} done`),
    onError = (chunkIndex, error) => console.error(`Chunk ${chunkIndex} failed:`, error.message)
  } = options;
  
  const chunks = chunkContent(content, maxChunkSize);
  const results = [];
  
  for (let i = 0; i < chunks.length; i++) {
    try {
      const result = await processFn(chunks[i], i, chunks.length);
      results.push(result);
      onChunk(i, chunks.length, result);
      if (i < chunks.length - 1) {
        await sleep(delayBetweenChunks);
      }
    } catch (error) {
      onError(i, error);
      throw error;
    }
  }
  
  return results;
}

// ---------- REAL LLM API CALL ----------

const PROVIDER_URLS = {
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  mistral: 'https://api.mistral.ai/v1/chat/completions',
  cerebras: 'https://api.cerebras.ai/v1/chat/completions',
  nvidia: 'https://integrate.api.nvidia.com/v1/chat/completions'
};

/**
 * Call the LLM API with the given messages and tools.
 * Returns { content, tool_calls } parsed from OpenAI-compatible response.
 */
export async function callLLMApi(messages, toolsList, provider, model, apiKey) {
  const url = PROVIDER_URLS[provider];
  if (!url) {
    throw new Error(`Unknown provider: ${provider}. Available: ${Object.keys(PROVIDER_URLS).join(', ')}`);
  }
  if (!model) {
    throw new Error('No model selected. Use /model to set one.');
  }
  if (!apiKey) {
    throw new Error(`No API key for ${provider}. Configure with setup wizard or set ${provider.toUpperCase()}_API_KEY env var.`);
  }

  console.log(`\n🤖 Calling ${provider}/${model}...`);

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
      tools: toolsList.length > 0 ? toolsList.map(t => t.function) : undefined,
      temperature: 0.7,
      max_tokens: 4096
    })
  });

  // Parse HTTP status for error reporting
  const statusCode = response.status;

  if (!response.ok) {
    let errorBody = '';
    try {
      errorBody = await response.text();
    } catch {}
    const error = new Error(`LLM API error: ${response.status} ${response.statusText}${errorBody ? ' — ' + errorBody.slice(0, 500) : ''}`);
    error.status = statusCode;
    throw error;
  }

  const data = await response.json();

  // Parse OpenAI-compatible response
  const choice = data.choices?.[0];
  if (!choice) {
    throw new Error(`Unexpected response format: no choices found. Raw: ${JSON.stringify(data).slice(0, 300)}`);
  }

  const message = choice.message;
  const finishReason = choice.finish_reason;

  // Extract content
  const content = message.content || '';

  // Extract tool calls if present
  let tool_calls = [];
  if (message.tool_calls && Array.isArray(message.tool_calls)) {
    tool_calls = message.tool_calls.map(tc => ({
      id: tc.id,
      type: tc.type,
      function: {
        name: tc.function?.name || '',
        arguments: tc.function?.arguments || '{}'
      }
    }));
  }

  console.log(`✅ Response from ${provider}/${model} (finish: ${finishReason})${content ? ', content: ' + content.slice(0, 80) + (content.length > 80 ? '...' : '') : ', no content'}`);

  return {
    content,
    tool_calls,
    finish_reason: finishReason
  };
}