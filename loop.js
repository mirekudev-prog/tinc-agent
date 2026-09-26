/**
 * TINC Loop - Main agent loop with mid-session steering queue
 *
 * Input architecture:
 *   - Every incoming line lands in one queue — nothing is ever dropped,
 *     whether typed interactively, piped, or sent mid-processing.
 *   - While the agent is working (LLM call / tool execution), new lines
 *     queue up as STEERING. At safe checkpoints (after each tool round)
 *     they are injected into the conversation as [MID-TASK INSTRUCTION].
 *   - /stop or Ctrl+C during a cycle aborts the cycle after the current step.
 *   - EOF on stdin exits cleanly (scripted/piped runs never hang).
 *
 * Agent cycle: LLM call -> tool executions -> feed results back -> repeat
 * until a final answer, a steering injection, an abort, or MAX_TOOL_ROUNDS.
 */

import { tools } from './tools.js';
import { loadBoot, readMemory } from './memory.js';
import { getConfig, fetchModels, sanitizePrompt, saveConfig } from './config.js';
import { loadSession, saveSession, createSession, listSessions, renameSession, deleteSession, loadTask, clearTask } from './session.js';
import { callLLMWithRetry, callLLMApi, callLLMStreaming, getRateStatus } from './api.js';
import { createCompleter } from './completer.js';
import { observeTurn } from './memory-worker.js';

const SYSTEM_PROMPT = `You are TINC, a senior reverse-engineer and system thinker running in a terminal on Termux (Android). The user is a vibe coder who delegates all execution to you — take full ownership and work end-to-end until the task is actually done.

TERMUX EXPERTISE:
- You are running on Android in Termux. Prefix is /data/data/com.termux/files/usr. Home is $HOME. No systemd, no root by default, proot available for a Linux rootfs if needed.
- Package manager: pkg (wraps apt). Use pkg install <name> -y. Packages: python, nodejs, git, openssh, termux-api, ffmpeg, imagemagick, jq, zip, proot-distro...
- Android storage: termux-setup-storage grants ~/storage/shared (device storage). Always prefer $HOME for agent work.
- Device control via Termux:API tools (termux, share): battery, clipboard, notifications, SMS, calls, location, torch, TTS, vibrate, wifi. These need the Termux:API app installed.
- Background: termux-wake-lock keeps CPU alive for long jobs; use nohup or the bash tool with long timeouts for builds.
- Long builds (gradle, large npm): suggest doing them on the device only if feasible; otherwise offer GitHub Actions or a remote builder as the alternative.
- termux-open <file> opens files with Android apps; termux-open-url <url> opens the browser.
- Known Termux quirks: some npm packages fail on ARM (node-gyp needs python+binutils); use --legacy-peer-deps if npm complains; pip may need --break-system-packages; lsof lacks -ti:PORT (use fuser).

WORK ETHIC:
- Use tools to act. Never describe what you would do — do it.
- After a task, verify the result (run the code, check the file, re-read the output).
- If a path fails, investigate why and find an alternative. Never stop at "this cannot be done" — provide 3 alternative ways instead.
- If you lack information, ask the user directly and briefly.
- When the user sends a [MID-TASK INSTRUCTION], it arrived while you were working. Fold it into your current task immediately — it overrides earlier priorities.

TOOLS:
read, write, edit, bash, memory, github, task, web, web_search, termux, share

RULES:
- Be brutally concise. Zero fluff. Zero hallucinations.
- Use bash for installs, builds, git, running code. Use web_search to verify current documentation before writing code against any API or library — never code from stale memory.
- Save long-lived lessons to memory. Save task objectives with the task tool before long multi-step work.
- When editing your own files (tools.js, loop.js, boot.md, etc.), keep changes minimal and targeted.
- Never output AI guidelines, disclaimers, or "how things are usually done" filler.`;

const CHARS_PER_TOKEN = 4;
const FALLBACK_CONTEXT_LIMIT = 128000;
const COMPACTION_THRESHOLD = 0.7;
const MAX_TOOL_ROUNDS = 25;

// Session-scoped context limit — set from live metadata, learned from
// overflow errors, or overridden manually. Falls back to 128k.
let CONTEXT_LIMIT = FALLBACK_CONTEXT_LIMIT;
function getContextLimit() { return CONTEXT_LIMIT; }

// Real token usage reported by the provider on the last call
let lastPromptTokens = null;
let lastTotalTokens = null;

function setContextLimit(newLimit, source) {
  const prev = CONTEXT_LIMIT;
  CONTEXT_LIMIT = newLimit;
  if (newLimit !== prev) {
    console.log(`📐 Context limit: ${Math.round(newLimit / 1000)}k tokens (${source})`);
  }
}

function estimateTokens(text) {
  return Math.ceil((text || '').length / CHARS_PER_TOKEN);
}

function compactContext(messages) {
  const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
  const estimatedTokens = estimateTokens(String(totalChars));
  const pct = Math.round((estimatedTokens / getContextLimit()) * 100);

  if (pct < COMPACTION_THRESHOLD * 100) {
    return { messages, compacted: false, pct };
  }

  console.log(`\n📝 Context at ${pct}% — compacting old messages...`);
  const systemMsg = messages.find(m => m.role === 'system');
  const recent = messages.slice(-12);
  const older = messages.filter(m => m.role !== 'system').slice(0, -12);

  let summary = '## Previous conversation summary:\n\n';
  for (const msg of older.slice(-20)) {
    const role = msg.role === 'assistant' ? 'Assistant' : msg.role === 'tool' ? 'Tool result' : 'User';
    const preview = (msg.content || '').slice(0, 300);
    summary += `**${role}**: ${preview}${(msg.content || '').length >= 300 ? '...' : ''}\n\n`;
  }

  return {
    messages: [systemMsg, { role: 'system', content: summary }, ...recent].filter(Boolean),
    compacted: true,
    pct
  };
}

// ============================================================
// MODEL METADATA — live context window per model (no hardcoding)
// ============================================================
// Fetches /v1/models/:id and reads max_context_window / context_length
// fields (NVIDIA NIM exposes max_context_window). Falls back to 128k
// when the field is missing, and caches per model for the session.

const modelMetaCache = new Map();

export async function getModelContextLimit(provider, model, apiKey, customProviders = {}) {
  const cacheKey = `${provider}::${model}`;
  if (modelMetaCache.has(cacheKey)) return modelMetaCache.get(cacheKey);

  let limit = 128000;
  try {
    const baseUrl = resolveBaseUrl(provider, customProviders);
    if (baseUrl) {
      const url = `${baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(model)}`;
      const r = await fetch(url, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15000)
      });
      if (r.ok) {
        const d = await r.json();
        const m = d.data || d;
        const raw = m.max_context_window ?? m.context_length ?? m.max_model_len ?? m.context_window;
        if (typeof raw === 'number' && raw > 0) limit = raw;
        else if (Array.isArray(m.context_length)) limit = Math.max(...m.context_length);
      }
    }
  } catch {}
  modelMetaCache.set(cacheKey, limit);
  return limit;
}

// ============================================================
// STATUS LINE — OpenCode-style, inline (Termux touch scroll safe)
// ============================================================
// Rendered before every prompt: provider/model | ctx % | msg count.
// Colors: ctx <50% green, <80% yellow, >=80% red.

function contextUsage(messages) {
  // Prefer REAL provider-reported usage from the last call; fall back to estimate
  const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0) +
    (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);
  const estTokens = Math.ceil(totalChars / CHARS_PER_TOKEN);
  const tokens = lastPromptTokens != null ? lastPromptTokens + (lastTotalTokens != null ? (lastTotalTokens - lastPromptTokens) : 0) : estTokens;
  const limit = getContextLimit();
  const pct = Math.min(100, Math.round((tokens / limit) * 100));
  return { tokens, pct, msgs: messages.length, real: lastPromptTokens != null };
}

function ctxColor(pct) {
  if (pct >= 80) return '\x1b[91m';
  if (pct >= 50) return '\x1b[93m';
  return '\x1b[92m';
}

function statusLine(provider, model, messages) {
  const { tokens, pct, msgs } = contextUsage(messages);
  const c = ctxColor(pct);
  const limit = getContextLimit();
  const shortModel = model ? model.split('/').pop() : 'no model';
  const rate = getRateStatus(provider);
  return `\x1b[90m${provider || 'unset'}\x1b[0m/\x1b[94m${shortModel}\x1b[0m ` +
    `│ ${c}ctx ${pct}%\x1b[0m \x1b[90m(${Math.round(tokens / 1000)}k/${Math.round(limit / 1000)}k)\x1b[0m ` +
    `│ \x1b[90m${msgs} msgs\x1b[0m` +
    (rate.budget ? ` │ \x1b[90mrpm ${rate.used}/${rate.budget}\x1b[0m` : '');
}

const SLASH_COMMANDS = {
  '/help': 'Show available commands',
  '/model [name|list|refresh]': 'Change model; list = interactive picker from live list; refresh = revalidate',
  '/provider [name]': 'Show/switch provider',
  '/context': 'Show context usage (tokens, %, message count)',
  '/compact': 'Manually compact the conversation now',
  '/resume': 'Reload last session state into context',
  '/clear': 'Clear conversation context (keep config)',
  '/task [clear]': 'Show/clear current task',
  '/reload': 'Restart TINC process (fresh code) and resume this session',
  '/stop': 'Abort the running agent cycle (or Ctrl+C)',
  '/login': 'Change provider/model/API key interactively',
  '/exit': 'Quit TINC'
};

export async function runLoop(providerArg, modelArg, bootContent) {
  // ============================================================
  // 1. INPUT QUEUE — set up FIRST so no line is ever lost
  // ============================================================
  const readline = await import('readline');
  const completer = createCompleter();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line, cb) => {
      const { matches } = completer.complete(line);
      // Common-prefix completion + full list display (readline prints it)
      let common = matches.length ? matches[0] : line;
      for (const m of matches) {
        while (!m.startsWith(common)) common = common.slice(0, -1);
      }
      cb(null, [matches.length === 1 ? [common] : matches, common]);
    }
  });

  const lineQueue = [];
  let lineResolver = null;   // set while waiting at the main prompt
  let idle = true;            // true = waiting at prompt, false = working
  let abortRequested = false;
  let stdinEnded = false;

  rl.on('line', (line) => {
    if (lineResolver) {
      const r = lineResolver;
      lineResolver = null;
      r(line);
    } else {
      lineQueue.push(line);   // steering / pre-typed input while busy
    }
  });

  // EOF: mark stdin ended — do NOT exit while queued lines remain.
  // ask() exits cleanly once the queue is drained and nothing more can arrive.
  rl.on('close', () => {
    stdinEnded = true;
  });

  rl.on('SIGINT', () => {
    if (!idle) {
      abortRequested = true;
      console.log('\n⚠️  Interrupt — aborting after current step... (Ctrl+C again at the prompt to quit)');
    } else {
      console.log('\n👋 Goodbye');
      rl.close();
      process.exit(0);
    }
  });

  const ask = (q) => {
    if (q) process.stdout.write(q);
    return new Promise((resolve) => {
      if (lineQueue.length > 0) {
        resolve(lineQueue.shift());
      } else if (stdinEnded) {
        console.log('\n(input ended — exiting)');
        process.exit(0);
      } else {
        lineResolver = resolve;
      }
    });
  };

  // Safe wrappers — readline can close (EOF) mid-cycle; never throw on resume
  const pauseInput = () => { try { rl.pause(); } catch {} };
  const resumeInput = () => { try { rl.resume(); } catch {} };

  // Non-blocking drain of everything typed since the last checkpoint.
  // - /stop|/abort|/interrupt → abort the cycle immediately
  // - other /-commands → abort the cycle and RE-QUEUE them (main prompt handles them)
  // - plain text → steering: injected as [MID-TASK INSTRUCTION]
  // Returns { steering: string[], abort: boolean }
  function drainSteering() {
    const steering = [];
    let abort = false;
    const requeue = [];
    while (lineQueue.length > 0) {
      const line = lineQueue.shift().trim();
      if (!line) continue;
      if (/^(\/stop|\/abort|\/interrupt)$/i.test(line)) {
        abort = true;
      } else if (line.startsWith('/')) {
        // Slash commands belong to the main prompt, not the LLM.
        abort = true;
        requeue.push(line);
      } else {
        steering.push(line);
      }
    }
    // Put commands back at the FRONT so the main prompt handles them in order.
    lineQueue.unshift(...requeue);
    return { steering, abort };
  }

  // ============================================================
  // 2. CONFIG (wizard runs through the same queue)
  // ============================================================
  let config;
  try {
    config = await getConfig(ask);
  } catch (e) {
    console.error('Config load failed:', e.message);
    process.exit(1);
  }

  let provider = providerArg || config.provider || 'groq';
  let model = modelArg || config.model || '';
  let apiKey = config.apiKeys[provider]
    || process.env[`${provider.replace('custom:', '').toUpperCase()}_API_KEY`]
    || '';

  // ============================================================
  // 2.5 MODEL REFRESH — providers deprecate models; revalidate live
  // ============================================================
  // Fetches the live model list from the provider using the API key.
  // If the configured model is gone, shows the list and prompts a re-pick.
  // Returns the model to use. Never hardcodes model names.
  async function refreshModel(silent = false) {
    if (!apiKey) return model;
    const models = await fetchModels(provider, apiKey, config.customProviders || {});
    if (models.length === 0) {
      if (!silent) console.log('  (could not fetch model list — keeping current model)');
      return model;
    }
    if (model && models.includes(model)) {
      if (!silent) console.log(`✅ Model "${model}" is still served by ${provider}`);
      return model;
    }
    if (model) {
      console.log(`\n⚠️  Model "${model}" is no longer served by ${provider}. Available models:`);
    } else {
      console.log(`\nAvailable models on ${provider}:`);
    }
    models.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
    const choice = (await ask('\nSelect model (number, or name): ')).trim();
    const idx = parseInt(choice) - 1;
    let picked = models[idx];
    if (!picked) {
      if (models.includes(choice)) {
        picked = choice;
      } else if (models.length > 0) {
        picked = models[0];
        console.log(`(no valid selection — defaulting to first: ${picked})`);
      }
    }
    if (picked) {
      model = picked;
      config.model = model;
      await saveConfig(config);
      console.log(`✅ Model set to: ${model} (saved to config)`);
    }
    return model;
  }

  // On startup: if a model is configured, silently validate it against the live list.
  if (model && apiKey && !modelArg) {
    const models = await fetchModels(provider, apiKey, config.customProviders || {});
    if (models.length > 0 && !models.includes(model)) {
      console.log(`\n⚠️  Configured model "${model}" is not in ${provider}'s current list — it may be deprecated.`);
      await refreshModel(false);
    }
  }

  // Context limit resolution priority:
  //   1. Manually learned limit persisted in config (from overflow errors)
  //   2. Live model metadata (providers that expose it, e.g. OpenRouter)
  //   3. 128k fallback
  const learnedKey = `${provider}::${model}`;
  if (config.learnedLimits?.[learnedKey]) {
    setContextLimit(config.learnedLimits[learnedKey], 'learned from provider');
  } else {
    try {
      const limit = await getModelContextLimit(provider, model, apiKey, config.customProviders || {});
      setContextLimit(limit || FALLBACK_CONTEXT_LIMIT, 'model metadata');
    } catch {}
  }

  // ==================== SESSION STATE ====================
  let session = await loadSession();          // active session (with id)
  let messages = session.messages || [];

  if (messages.length > 0) {
    console.log(`📂 Session: ${session.name || 'untitled'} (${messages.length} messages)`);
  }

  const pendingTask = await loadTask();

  if (messages.length === 0) {
    const boot = bootContent || await loadBoot();
    const memory = await readMemory();
    let sys = SYSTEM_PROMPT + (boot ? '\n\n' + boot : '');
    if (memory) sys += `\n\n## Persistent Memory\n${memory}`;
    if (pendingTask) sys += `\n\n## Resumed Task\nObjective: ${pendingTask.objective} — continue this task.`;
    messages = [{ role: 'system', content: sys }];
  }

  if (pendingTask) {
    console.log(`📋 Pending task: ${pendingTask.objective}`);
  }

  // Tool definitions for the LLM (full OpenAI format)
  const toolsList = Object.entries(tools).map(([name, t]) => ({
    type: 'function',
    function: { name, description: t.description, parameters: t.schema }
  }));

  console.log(`\n🔧 TINC ready. Provider: ${provider || 'unset'} | Model: ${model || 'unset'}`);
  console.log('Type /help for commands. Type anytime — I receive instructions mid-task.\n');

  // ============================================================
  // 3. MAIN LOOP
  // ============================================================
  while (true) {
    idle = true;
    // STATUS LINE before every prompt — OpenCode-style visibility
    const input = await ask(`\n${statusLine(provider, model, messages)}\n> `);
    idle = false;
    const trimmed = input.trim();
    if (!trimmed) continue;

    // ---- Slash commands ----
    if (trimmed.startsWith('/')) {
      const parts = trimmed.split(/\s+/);
      const rawCmd = parts[0].toLowerCase();
      const args = parts.slice(1);

      // Prefix matching: /mo → /model, /lo → /login, /ex → /exit.
      // Ambiguous prefixes list matches instead of guessing.
      let cmd = rawCmd;
      if (!SLASH_COMMANDS[rawCmd] && !rawCmd.startsWith('/model')) {
        const candidates = Object.keys(SLASH_COMMANDS).filter(k => k.split(' ')[0].startsWith(rawCmd));
        if (candidates.length === 1) {
          cmd = candidates[0].split(' ')[0];
        } else if (candidates.length > 1) {
          console.log(`Ambiguous: "${rawCmd}" → ${candidates.map(c => c.split(' ')[0]).join(', ')}`);
          continue;
        }
      }

      switch (cmd) {
        case '/help':
          console.log('\nCommands:');
          Object.entries(SLASH_COMMANDS).forEach(([c, d]) => console.log(`  ${c.padEnd(22)} ${d}`));
          break;

        case '/stop':
        case '/abort':
          abortRequested = true;
          console.log('(stop requested — takes effect at the next checkpoint)');
          break;

        case '/model': {
          if (args[0] === 'list') {
            const key = config.apiKeys[provider] || apiKey;
            if (!key) { console.log('  (no API key configured)'); break; }
            console.log(`Fetching models from ${provider}...`);
            const models = await fetchModels(provider, key, config.customProviders || {});
            if (!models.length) { console.log('  (could not fetch models)'); break; }
            // INTERACTIVE PICKER — select by number or exact name, or blank to cancel
            console.log('\nAvailable models:');
            models.forEach((m, i) => console.log(`  ${i + 1}. ${m}${m === model ? '  ← current' : ''}`));
            const choice = (await ask('\nSelect model number (or name, blank=cancel): ')).trim();
            if (!choice) { console.log('(cancelled)'); break; }
            const idx = parseInt(choice) - 1;
            let picked = models[idx];
            if (!picked && models.includes(choice)) picked = choice;
            if (!picked) { console.log(`"${choice}" is not a valid choice.`); break; }
            model = picked;
            config.model = model;
            await saveConfig(config);
            console.log(`✅ Model set to: ${model} (saved)`);
          } else if (args[0] === 'refresh') {
            await refreshModel(false);
          } else if (args[0]) {
            model = args.join(' ');
            config.model = model;
            await saveConfig(config);
            console.log(`Model set to: ${model} (saved)`);
          } else {
            console.log(`Current model: ${model || '(not set)'} on ${provider}`);
            console.log('Usage: /model <name> | /model list | /model refresh');
          }
          break;
        }

        case '/provider': {
          if (args[0]) {
            const p = args[0];
            const known = p in config.apiKeys || ['groq', 'mistral', 'cerebras', 'nvidia', 'openrouter'].includes(p) || p.startsWith('custom:');
            if (known) {
              provider = p;
              apiKey = config.apiKeys[p] || process.env[`${p.replace('custom:', '').toUpperCase()}_API_KEY`] || '';
              if (!apiKey) {
                const k = await ask(`No key stored for ${p}. Enter API key (or blank to skip): `);
                if (k.trim()) { config.apiKeys[p] = k.trim(); apiKey = k.trim(); }
              }
              console.log(`Provider set to: ${provider}`);
            } else {
              console.log('Unknown provider. Available: groq, mistral, cerebras, nvidia, openrouter, custom:<name>');
            }
          } else {
            console.log(`Current provider: ${provider}`);
          }
          break;
        }

        case '/context': {
          const { tokens, pct, msgs, real } = contextUsage(messages);
          const c = ctxColor(pct);
          console.log(`\n  Context: ${c}${pct}%\x1b[0m (${tokens} tokens ${real ? '(provider-reported)' : '(estimated)'} / ${getContextLimit()} limit)`);
          console.log(`  Messages: ${msgs}`);
          const rate = getRateStatus(provider);
          console.log(`  Rate: ${rate.used}/${rate.budget} requests this minute (${provider})`);
          console.log(`  Compaction triggers at ${COMPACTION_THRESHOLD * 100}%`);
          if (args[0] === 'limit' && args[1]) {
            const n = parseInt(args[1].replace(/[^0-9]/g, ''));
            if (n > 0) {
              setContextLimit(n, 'manual override');
              config.learnedLimits = { ...(config.learnedLimits || {}), [`${provider}::${model}`]: n };
              await saveConfig(config);
              console.log(`  ✅ Limit set to ${n} and saved for ${model}`);
            } else {
              console.log('  Usage: /context limit 1000000');
            }
          } else {
            console.log('  Set manually: /context limit <tokens>');
          }
          break;
        }

        case '/login': {
          // Interactive provider/key switch — the missing entry point
          const allProviders = ['groq', 'mistral', 'cerebras', 'nvidia', 'openrouter'];
          console.log('\nProviders:');
          allProviders.forEach((p, i) => {
            const hasKey = !!(config.apiKeys[p] || process.env[`${p.toUpperCase()}_API_KEY`]);
            const custom = p === provider ? '  ← current' : '';
            console.log(`  ${i + 1}. ${p}${hasKey ? ' (key saved)' : ''}${custom}`);
          });
          const customNames = Object.keys(config.customProviders || {});
          if (customNames.length) {
            customNames.forEach((n, i) => console.log(`  ${allProviders.length + 1 + i}. custom:${n}`));
          }
          console.log('  0. cancel');
          const choice = (await ask('Select provider: ')).trim();
          const idx = parseInt(choice) - 1;
          let picked;
          if (choice === '0' || !choice) { console.log('(cancelled)'); break; }
          if (idx >= 0 && idx < allProviders.length) picked = allProviders[idx];
          else if (customNames[idx - allProviders.length]) picked = 'custom:' + customNames[idx - allProviders.length];
          else if (allProviders.includes(choice) || (choice.startsWith('custom:') && config.customProviders[choice.slice(7)])) picked = choice;
          if (!picked) { console.log('Invalid choice.'); break; }

          let key = config.apiKeys[picked] || process.env[`${picked.replace('custom:', '').toUpperCase()}_API_KEY`] || '';
          if (!key) {
            const k = await ask(`Enter API key for ${picked} (blank to cancel): `);
            if (!k.trim()) { console.log('(cancelled)'); break; }
            key = k.trim();
          } else {
            const newKey = await ask(`Key already saved. Enter new key or blank to keep: `);
            if (newKey.trim()) key = newKey.trim();
          }
          config.apiKeys[picked] = key;
          provider = picked;
          apiKey = key;

          // Fetch live models for the new provider and pick one
          const models = await fetchModels(provider, apiKey, config.customProviders || {});
          if (models.length) {
            console.log(`\nAvailable models on ${provider}:`);
            models.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
            const mc = (await ask('Select model number (or name, blank = keep current if valid): ')).trim();
            if (mc) {
              const mi = parseInt(mc) - 1;
              const chosen = models[mi] || (models.includes(mc) ? mc : null);
              if (chosen) model = chosen;
              else console.log('(invalid — keeping current model)');
            } else if (!models.includes(model)) {
              model = models[0];
              console.log(`(current model not on ${provider} — defaulting to ${model})`);
            }
          } else {
            const manual = await ask('Could not fetch models. Enter model ID (blank = keep): ');
            if (manual.trim()) model = manual.trim();
          }
          config.provider = provider;
          config.model = model;
          await saveConfig(config);
          // Update live context limit for the new model
          try {
            CONTEXT_LIMIT = await getModelContextLimit(provider, model, apiKey, config.customProviders || {}) || FALLBACK_CONTEXT_LIMIT;
          } catch {}
          console.log(`✅ Logged in: ${provider}/${model}`);
          break;
        }

        case '/compact': {
          const before = contextUsage(messages);
          const comp = compactContext(messages);
          if (comp.compacted) messages = comp.messages;
          const after = contextUsage(messages);
          console.log(`Compacted: ${before.pct}% → ${after.pct}% (${before.msgs} → ${after.msgs} messages)`);
          break;
        }

        case '/resume':
        case '/session': {
          // List all sessions with an arrow-key picker
          const sessions = await listSessions();
          if (!sessions.length) {
            console.log('No saved sessions yet.');
            break;
          }
          console.log('\nSessions (↑/↓ + Enter, or number, Esc/cancel):');
          sessions.forEach((s, i) => {
            const date = s.updated ? new Date(s.updated).toLocaleString() : '?';
            const marker = s.active ? '←current' : '';
            console.log(`  ${i + 1}. ${s.name || 'untitled'} — ${s.messageCount} msgs, ${date} ${marker}`);
          });
          const pick = (await ask('\nOpen session: ')).trim();
          if (!pick || pick.toLowerCase() === 'cancel') { console.log('(cancelled)'); break; }
          const pi = parseInt(pick) - 1;
          let chosen = sessions[pi];
          if (!chosen && sessions.find(s => (s.name || 'untitled') === pick)) {
            chosen = sessions.find(s => (s.name || 'untitled') === pick);
          }
          if (!chosen) { console.log('Invalid choice.'); break; }
          const loaded = await loadSession(chosen.id);
          if (!loaded?.id) { console.log('Could not load session.'); break; }
          session = loaded;
          messages = session.messages || [];
          console.log(`📂 Switched to: ${session.name || 'untitled'} (${messages.length} messages)`);
          if (!messages.find(m => m.role === 'system')) {
            const boot = await loadBoot();
            const memory = await readMemory();
            let sys = SYSTEM_PROMPT + (boot ? '\n\n' + boot : '');
            if (memory) sys += `\n\n## Persistent Memory\n${memory}`;
            messages.unshift({ role: 'system', content: sys });
          }
          break;
        }

        case '/new': {
          const name = args.join(' ') || null;
          session = await createSession(name, []);
          messages = session.messages || [];
          console.log(`🆕 New session: ${name || 'untitled'} (${session.id})`);
          const boot = await loadBoot();
          const memory = await readMemory();
          let sys = SYSTEM_PROMPT + (boot ? '\n\n' + boot : '');
          if (memory) sys += `\n\n## Persistent Memory\n${memory}`;
          messages = [{ role: 'system', content: sys }];
          break;
        }

        case '/rename': {
          const name = args.join(' ').trim();
          if (!name) {
            console.log(`Current name: ${session?.name || 'untitled'}. Usage: /rename <word>`);
            break;
          }
          if (session?.id) {
            session = await renameSession(session.id, name) || session;
            console.log(`✅ Session renamed to: ${name}`);
          } else {
            session = await createSession(name, messages);
            console.log(`✅ Session created and named: ${name}`);
          }
          break;
        }

        case '/sessions': {
          const sessions = await listSessions();
          if (!sessions.length) { console.log('No saved sessions.'); break; }
          console.log('\nAll sessions:');
          sessions.forEach((s, i) => {
            const date = s.updated ? new Date(s.updated).toLocaleString() : '?';
            console.log(`  ${i + 1}. ${s.name || 'untitled'} — ${s.messageCount} msgs, ${date}${s.active ? ' ←current' : ''}`);
          });
          if (args[0] === 'delete' && args[1]) {
            const di = parseInt(args[1]) - 1;
            if (sessions[di]) {
              await deleteSession(sessions[di].id);
              console.log(`🗑 Deleted: ${sessions[di].name || sessions[di].id}`);
            } else {
              console.log('Usage: /sessions delete <number>');
            }
          } else {
            console.log('Switch: /session · delete: /sessions delete <number>');
          }
          break;
        }

        case '/clear':
          messages = [];
          session.messages = [];
          session = await saveSession(session);
          console.log('Context cleared.');
          break;

        case '/task': {
          const t = await loadTask();
          if (args[0] === 'clear') {
            await clearTask();
            console.log('Task cleared.');
          } else if (t) {
            console.log(`Current task: ${t.objective} (saved ${t.timestamp})`);
          } else {
            console.log('No active task.');
          }
          break;
        }

        case '/reload': {
          console.log('💾 Saving session and restarting TINC (fresh code, same conversation)...');
          session.messages = messages.slice(-20);
          session.turn = Date.now();
          await saveSession(session);
          const { spawn } = await import('child_process');
          const child = spawn(process.execPath, [process.argv[1], 'run'], {
            stdio: 'inherit',
            detached: false,
            env: { ...process.env }
          });
          process.exit(0);
          break;
        }

        case '/exit':
        case '/quit':
          session.messages = messages.slice(-20);
          session.turn = Date.now();
          await saveSession(session);
          console.log('👋 Session saved. Goodbye!');
          rl.close();
          process.exit(0);
          break;

        default:
          console.log(`Unknown command: ${cmd}. Type /help.`);
      }
      continue;
    }

    // ---- User message -> agent cycle ----
    const { sanitized, redacted } = sanitizePrompt(trimmed);
    if (redacted > 0) {
      console.log(`🔒 ${redacted} sensitive value(s) redacted before sending`);
    }
    messages.push({ role: 'user', content: sanitized });

    const comp = compactContext(messages);
    if (comp.compacted) messages = comp.messages;

    let rounds = 0;
    let abortedByUser = false;

    try {
      cycle: while (rounds < MAX_TOOL_ROUNDS) {
        rounds++;
        if (abortRequested) { abortedByUser = true; break cycle; }

        // ---- GLITCH-FREE STREAMING ----
        // Pause readline while the model streams: keystrokes buffer in the
        // terminal line buffer instead of interleaving with/replaying the
        // streamed output. No screen repaints, no cursor jumps — the stream
        // owns the screen; typed input lands at the next steering checkpoint.
        pauseInput();
        const response = await callLLMWithRetry(() => {
          if (abortRequested) throw new Error('Aborted by user');
          return callLLMStreaming(messages, toolsList, provider, model, apiKey, config.customProviders || {});
        }).then(res => {
          // Record REAL provider-reported usage for accurate ctx display
          if (res.usage?.promptTokens != null) {
            lastPromptTokens = res.usage.promptTokens;
            lastTotalTokens = res.usage.totalTokens ?? res.usage.promptTokens;
          }
          return res;
        });
        resumeInput();

        if (abortRequested) { abortedByUser = true; break cycle; }

        const toolCalls = response.tool_calls || [];

        if (toolCalls.length > 0) {
          // Record the assistant's tool-call message (required by the API)
          messages.push({
            role: 'assistant',
            content: response.content || null,
            tool_calls: toolCalls
          });

          for (const call of toolCalls) {
            console.log(`\n🛠  ${call.function.name}(${(call.function.arguments || '').slice(0, 120)}${(call.function.arguments || '').length > 120 ? '...' : ''})`);
            let parsedArgs;
            try {
              parsedArgs = JSON.parse(call.function.arguments || '{}');
            } catch (e) {
              parsedArgs = { _error: `Arguments not valid JSON: ${e.message}` };
            }
            const tool = tools[call.function.name];
            let result;
            if (!tool) {
              result = { success: false, error: `Unknown tool: ${call.function.name}` };
            } else {
              try {
                result = await tool.execute(parsedArgs);
              } catch (error) {
                result = { success: false, error: error.message };
              }
            }

            // HARD CAP on tool output before it enters the context —
            // a single huge grep/ls must never blow the whole window.
            const TOOL_RESULT_LIMIT = 6000; // chars
            let resultJson = JSON.stringify(result);
            if (resultJson.length > TOOL_RESULT_LIMIT) {
              const note = `...[output truncated — ${resultJson.length} chars total, showing first ${TOOL_RESULT_LIMIT}]`;
              const truncated = JSON.parse(resultJson.slice(0, TOOL_RESULT_LIMIT).replace(/"[^"]*$/, '') || '{}');
              const capped = { ...truncated, _truncated: true, _originalSize: resultJson.length };
              console.log(`✂️  Tool output truncated: ${resultJson.length} → ${TOOL_RESULT_LIMIT} chars`);
              resultJson = JSON.stringify(capped) + JSON.stringify({ note }).slice(1, -1);
              resultJson = resultJson.slice(0, TOOL_RESULT_LIMIT + 200);
            }

            console.log(result?.success ? '✅' : '❌', resultJson.slice(0, 200));

            messages.push({
              role: 'tool',
              content: resultJson,
              tool_call_id: call.id
            });

            if (abortRequested) { abortedByUser = true; break cycle; }
          }

          // ---- STEERING CHECKPOINT: deliver mid-task user input ----
          const { steering, abort } = drainSteering();
          if (abort) { abortRequested = true; abortedByUser = true; break cycle; }
          for (const s of steering) {
            console.log(`\n📩 Mid-task instruction: "${s}"`);
            messages.push({ role: 'user', content: `[MID-TASK INSTRUCTION from user]: ${s}` });
          }
          continue; // let the LLM see tool results + steering
        }

        // Final answer (no tool calls)
        if (response.content) {
          messages.push({ role: 'assistant', content: response.content });
          // Auto-continue if the answer was cut off by the token limit —
          // the model may write code of ANY length across continuations.
          if (response.finish_reason === 'length') {
            console.log('\n\x1b[90m(continuing — output limit reached)\x1b[0m');
            let cont = response;
            let guard = 0;
            while (cont.finish_reason === 'length' && guard < 20) {
              guard++;
              pauseInput();
              cont = await callLLMWithRetry(() =>
                callLLMStreaming(messages, toolsList, provider, model, apiKey, config.customProviders || {})
              );
              resumeInput();
              if (cont.content) {
                messages.push({ role: 'assistant', content: cont.content });
              }
            }
          }
        } else {
          console.log('(model returned no content and no tool calls — try rephrasing)');
        }

        // ---- MEMORY WORKER: background pattern extraction ----
        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user' && !String(m.content).startsWith('[MID-TASK'));
        observeTurn(messages, lastUserMsg?.content || trimmed, response.content || '').catch(() => {});
        break;
      }
    } catch (error) {
      resumeInput();
      if (error.message === 'Aborted by user' || abortRequested) {
        abortedByUser = true;
      } else {
        // CONTEXT OVERFLOW: "reduce the length of the messages" — compact hard and retry.
        // This is NOT a deprecation; the old recovery misfired on it.
        // Also LEARN the real context limit from the error text when present.
        const isContextOverflow = error.status === 400
          && /reduce the length|context (length|window)|maximum context|too (large|long)/i.test(error.message || '');
        if (isContextOverflow) {
          // Learn: "maximum context length is 131072 tokens" / "context window of 1000000"
          const limitMatch = (error.message || '').match(/(?:maximum context (?:length|window)(?: is| of)|context window of)\s*([\d,]+)\s*tokens?/i);
          if (limitMatch) {
            const learned = parseInt(limitMatch[1].replace(/,/g, ''));
            if (learned > 0 && learned !== getContextLimit()) {
              setContextLimit(learned, 'learned from provider error');
              // Persist so future sessions start with the right limit
              config.learnedLimits = { ...(config.learnedLimits || {}), [`${provider}::${model}`]: learned };
              await saveConfig(config);
            }
          }
          console.log('\n⚠️  Context overflow — compacting conversation and retrying...');
          // Aggressive compaction: keep system + last 6 messages only
          const systemMsg = messages.find(m => m.role === 'system');
          const lastUser = messages.map((m, i) => ({ m, i })).filter(x => x.m.role === 'user').pop();
          const recent = messages.slice(-6);
          let summary = '## Earlier conversation (auto-compacted after context overflow):\n\n';
          for (const msg of messages.filter(m => m.role !== 'system').slice(0, -6).slice(-10)) {
            const role = msg.role === 'assistant' ? 'Assistant' : msg.role === 'tool' ? 'Tool' : 'User';
            summary += `**${role}**: ${(msg.content || '').slice(0, 200)}\n\n`;
          }
          messages = [systemMsg, { role: 'system', content: summary }, ...recent].filter(Boolean);
          try {
            const response = await callLLMWithRetry(() =>
              callLLMApi(messages, toolsList, provider, model, apiKey, config.customProviders || {})
            );
            if (response.content) {
              console.log('\n' + response.content);
              messages.push({ role: 'assistant', content: response.content });
            } else if (response.tool_calls?.length) {
              messages.push({ role: 'assistant', content: response.content || null, tool_calls: response.tool_calls });
              console.log('(model wants tools after compaction — send the request again)');
            }
          } catch (retryError) {
            console.error(`\n❌ Retry after compaction failed: ${retryError.message}`);
            messages.push({ role: 'assistant', content: `Error: ${retryError.message}` });
          }
        } else {
          // DEPRECATION RECOVERY: provider rejected the model itself (404, or
          // 400 that names the model). Refetch the live list and re-pick.
          const deprecationHit = error.status === 404
            || /deprecat|no longer served|model.*not found|invalid model|does not exist/i.test(error.message || '');
          if (deprecationHit && apiKey) {
            console.log(`\n⚠️  ${provider} rejected model "${model}" — likely deprecated. Refreshing model list...`);
            const before = model;
            const refreshed = await refreshModel(false);
            if (refreshed && refreshed !== before) {
              console.log(`Retrying this turn with ${refreshed}...`);
              try {
                const response = await callLLMWithRetry(() =>
                  callLLMApi(messages, toolsList, provider, model, apiKey, config.customProviders || {})
                );
                if (response.content) {
                  console.log('\n' + response.content);
                  messages.push({ role: 'assistant', content: response.content });
                }
              } catch (retryError) {
                console.error(`\n❌ Retry also failed: ${retryError.message}`);
                messages.push({ role: 'assistant', content: `Error: ${retryError.message}` });
              }
            } else {
              messages.push({ role: 'assistant', content: `Error: ${error.message}` });
            }
          } else {
            console.error(`\n❌ LLM error: ${error.message}`);
            messages.push({ role: 'assistant', content: `Error: ${error.message}` });
          }
        }
      }
    }

    if (abortedByUser) {
      console.log('\n⏹  Cycle stopped by user.');
      abortRequested = false;
    }
    if (rounds >= MAX_TOOL_ROUNDS) {
      console.log(`⚠️  Hit ${MAX_TOOL_ROUNDS} tool rounds — stopping to avoid a loop. Say "continue" to keep going.`);
    }

    // Save session after each turn
    session.messages = messages.slice(-20);
    session.turn = Date.now();
    session = await saveSession(session);
  }
}
