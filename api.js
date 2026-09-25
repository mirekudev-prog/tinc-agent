/**
 * TINC API Caller - Smart retries with exponential backoff
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
 * Handles rate limits by processing chunks sequentially
 */
export function chunkContent(content, maxChunkSize = 8000) {
  if (content.length <= maxChunkSize) {
    return [content];
  }
  
  const chunks = [];
  let start = 0;
  
  while (start < content.length) {
    // Try to break at natural boundaries (newlines, paragraphs)
    let end = Math.min(start + maxChunkSize, content.length);
    
    if (end < content.length) {
      // Find last newline before maxChunkSize
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
      
      // Rate limit delay between chunks
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