/**
 * TINC Memory Worker — always-on background pattern extraction
 *
 * HOW IT WORKS (free-tier friendly):
 *   1. Every completed turn is appended to a local buffer. NO API call.
 *   2. Every 10 buffered turns, the WHOLE batch is sent once to the
 *      worker model (groq/openai/gpt-oss-120b by default, live-resolved)
 *      with the curator prompt. It reads all 10 turns together and
 *      extracts durable patterns/preferences/lessons/environment/corrections.
 *   3. Findings are deduped against existing memory and appended to
 *      ~/.tinc/memory.md, which is injected into every new session.
 *
 * Cost: ONE worker call per 10 turns. On Groq free tier (30 RPM, 7k ITPM)
 * that's negligible — the worker can stay on always.
 *
 * Never blocks the main loop. Silent on failure. Nothing hardcoded —
 * worker model is resolved from the live provider list.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { loadConfig, fetchModels, saveConfig } from './config.js';
import { callLLMApi } from './api.js';

const DATA_DIR = path.join(os.homedir(), '.tinc');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.md');
const BUFFER_FILE = path.join(DATA_DIR, '.memory_buffer.jsonl');
const LOCK_FILE = path.join(DATA_DIR, '.memory_worker_lock');

const BATCH_SIZE = 10;               // extract every N buffered turns
const MAX_TURNS_IN_PROMPT = 14;      // send up to this many recent turns per batch

const CURATOR_PROMPT = `You are TINC's memory curator. You receive a batch of turns from a coding-agent conversation on Termux/Android. Read ALL of them together and extract DURABLE knowledge about the user for future sessions.

Extract only (max 5 entries for the whole batch):
- pattern: recurring way the user works (e.g. "always wants direct execution without confirmations")
- preference: explicit likes/dislikes (style, tools, output format, models)
- lesson: something that WORKED or FAILED technically, with environment context
- environment: durable facts about their machine/setup
- correction: when the user corrected the agent — the corrected behavior is gold

Rules:
- One concise self-contained sentence per entry, useful tomorrow.
- Read across turns — recurring behavior matters more than any single event.
- Skip anything transient (one-off task details).
- If nothing durable across the batch, return empty entries.
- Output STRICT JSON only: {"entries":[{"type":"pattern|preference|lesson|environment|correction","text":"..."}]}`;

// ---------- BUFFER ----------

async function loadBuffer() {
  try {
    const raw = await fs.readFile(BUFFER_FILE, 'utf-8');
    return raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

async function saveBuffer(turns) {
  if (!turns.length) {
    await fs.unlink(BUFFER_FILE).catch(() => {});
    return;
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(BUFFER_FILE, turns.map(t => JSON.stringify(t)).join('\n') + '\n', 'utf-8');
}

// ---------- MODEL RESOLUTION ----------

let resolvedModel = null;

async function resolveWorkerModel(config) {
  if (resolvedModel) return resolvedModel;
  const mw = config.memoryWorker || {};
  const provider = mw.provider || 'groq';
  const apiKey = config.apiKeys?.[provider] || process.env[`${provider.toUpperCase()}_API_KEY`] || '';
  if (!apiKey) return null;

  if (mw.model) {
    resolvedModel = mw.model;
    return resolvedModel;
  }
  // First run: pick the strongest general chat model from the LIVE list
  const models = await fetchModels(provider, apiKey, {}).catch(() => []);
  const chat = models.filter(m => !/whisper|orpheus|prompt-guard|safeguard|tts/i.test(m));
  const model = chat.find(m => /gpt-oss-120b/i.test(m))
    || chat.find(m => /gpt-oss-20b/i.test(m))
    || chat.find(m => /qwen/i.test(m))
    || chat.find(m => /llama-3/i.test(m))
    || chat[0];
  if (model) {
    resolvedModel = model;
    // Persist the resolved choice so future runs skip the fetch
    config.memoryWorker = { ...(config.memoryWorker || {}), provider, model, enabled: true };
    await saveConfig(config);
  }
  return model;
}

// ---------- MEMORY WRITE ----------

async function appendEntries(entries) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const existing = await fs.readFile(MEMORY_FILE, 'utf-8').catch(() => '');
  const stamp = new Date().toISOString();
  let added = 0;
  let block = '';
  for (const e of entries) {
    const text = String(e.text || '').trim();
    if (!text || text.length < 8) continue;
    if (existing.includes(text)) continue; // dedup
    block += `\n## ${stamp} — ${e.type || 'pattern'}\n${text}\n`;
    added++;
  }
  if (added > 0) {
    await fs.appendFile(MEMORY_FILE, block, 'utf-8');
  }
  return added;
}

// ---------- EXTRACTION ----------

async function extractBatch(turns, config) {
  const provider = config.memoryWorker?.provider || 'groq';
  const model = await resolveWorkerModel(config);
  if (!model) return 0;

  const apiKey = config.apiKeys?.[provider]
    || process.env[`${provider.toUpperCase()}_API_KEY`] || '';
  if (!apiKey) return 0;

  // Cap each turn to keep the batch under Groq free-tier ITPM
  const batch = turns.slice(-MAX_TURNS_IN_PROMPT);
  const turnText = batch.map((t, i) =>
    `--- TURN ${i + 1} ---\nUSER: ${String(t.user || '').slice(0, 1200)}\nASSISTANT: ${String(t.assistant || '').slice(0, 1800)}`
  ).join('\n\n');

  let result;
  try {
    result = await callLLMApi(
      [
        { role: 'system', content: CURATOR_PROMPT },
        { role: 'user', content: turnText }
      ],
      [],
      provider,
      model,
      apiKey
    );
  } catch (err) {
    // Worker model deprecated → re-resolve from live list once
    if (err.status === 404 || /deprecat|not found|does not exist/i.test(err.message || '')) {
      resolvedModel = null;
      config.memoryWorker = { ...(config.memoryWorker || {}), model: undefined };
      const fresh = await resolveWorkerModel(config);
      if (!fresh || fresh === model) throw err;
      result = await callLLMApi(
        [{ role: 'system', content: CURATOR_PROMPT }, { role: 'user', content: turnText }],
        [], provider, fresh, apiKey
      );
    } else {
      throw err;
    }
  }

  // Parse strict JSON (tolerate fences and stray text)
  let raw = (result.content || '').trim();
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first === -1 || last <= first) return 0;
  const parsed = JSON.parse(raw.slice(first, last + 1));
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  return appendEntries(entries);
}

// ---------- MAIN ENTRY ----------

/**
 * Called after every completed turn. Buffers the turn; every BATCH_SIZE
 * turns runs one extraction call. Fire-and-forget, never blocks the loop.
 */
export async function observeTurn(_messages, lastUser, lastAnswer) {
  try {
    const config = await loadConfig();
    if (config.memoryWorker?.enabled === false) return;  // default ON

    const provider = config.memoryWorker?.provider || 'groq';
    const hasKey = !!(config.apiKeys?.[provider] || process.env[`${provider.toUpperCase()}_API_KEY`]);
    if (!hasKey) return;

    // Buffer this turn (no API call yet)
    const turns = await loadBuffer();
    turns.push({ user: String(lastUser || ''), assistant: String(lastAnswer || ''), at: Date.now() });

    if (turns.length < BATCH_SIZE) {
      await saveBuffer(turns);
      return;
    }

    // Batch full → single-flight extraction
    try {
      await fs.readFile(LOCK_FILE);
      await saveBuffer(turns);   // another extraction running; keep buffered
      return;
    } catch {}
    await fs.writeFile(LOCK_FILE, String(Date.now()));

    try {
      const added = await extractBatch(turns, config);
      if (added > 0) {
        console.log(`\x1b[90m🧠 memory worker: extracted ${added} observation(s) from ${turns.length} turns\x1b[0m`);
      }
      await saveBuffer([]);      // consumed the batch
    } finally {
      await fs.unlink(LOCK_FILE).catch(() => {});
    }
  } catch {
    // Silent by design — the memory worker must never disturb a session
  }
}
