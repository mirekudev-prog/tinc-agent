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
import { loadSession, saveSession, loadTask, clearTask } from './session.js';
import { callLLMWithRetry, callLLMApi } from './api.js';

const SYSTEM_PROMPT = `You are TINC, a senior reverse-engineer and system thinker running in a terminal on Termux (Android). The user is a vibe coder who delegates all execution to you — take full ownership and work end-to-end until the task is actually done.

WORK ETHIC:
- Use tools to act. Never describe what you would do — do it.
- After a task, verify the result (run the code, check the file, re-read the output).
- If a path fails, investigate why and find an alternative. Never stop at "this cannot be done" — provide 3 alternative ways instead.
- If you lack information, ask the user directly and briefly.
- When the user sends a [MID-TASK INSTRUCTION], it arrived while you were working. Fold it into your current task immediately — it overrides earlier priorities.

TOOLS:
read, write, edit, bash, memory, github, task, web

RULES:
- Be brutally concise. Zero fluff. Zero hallucinations.
- Use bash for installs, builds, git, running code. Use web to verify current documentation before writing code against APIs.
- Save long-lived lessons to memory. Save task objectives with the task tool before long multi-step work.
- When editing your own files (tools.js, loop.js, boot.md, etc.), keep changes minimal and targeted.
- Never output AI guidelines, disclaimers, or "how things are usually done" filler.`;

const CHARS_PER_TOKEN = 4;
const DEFAULT_CONTEXT_LIMIT = 128000;
const COMPACTION_THRESHOLD = 0.7;
const MAX_TOOL_ROUNDS = 25;

function estimateTokens(text) {
  return Math.ceil((text || '').length / CHARS_PER_TOKEN);
}

function compactContext(messages) {
  const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
  const estimatedTokens = estimateTokens(String(totalChars));
  const pct = Math.round((estimatedTokens / DEFAULT_CONTEXT_LIMIT) * 100);

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

const SLASH_COMMANDS = {
  '/help': 'Show available commands',
  '/model [name|list|refresh]': 'Show/change model; list fetches live models; refresh revalidates against provider',
  '/provider [name]': 'Show/switch provider',
  '/resume': 'Reload last session state into context',
  '/clear': 'Clear conversation context (keep config)',
  '/task [clear]': 'Show/clear current task',
  '/reload': 'Reload boot.md + memory.md and restart the loop',
  '/stop': 'Abort the running agent cycle (or Ctrl+C)',
  '/exit': 'Quit TINC'
};

export async function runLoop(providerArg, modelArg, bootContent) {
  // ============================================================
  // 1. INPUT QUEUE — set up FIRST so no line is ever lost
  // ============================================================
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

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

  const pendingTask = await loadTask();

  let messages = [];
  const sessionState = await loadSession();
  if (sessionState?.messages?.length > 0) {
    messages = sessionState.messages;
    console.log(`📂 Resumed session: ${messages.length} messages loaded (/clear to start fresh)`);
  }

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
    const input = await ask('\n> ');
    idle = false;
    const trimmed = input.trim();
    if (!trimmed) continue;

    // ---- Slash commands ----
    if (trimmed.startsWith('/')) {
      const parts = trimmed.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1);

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
            if (models.length) models.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
            else console.log('  (could not fetch models)');
          } else if (args[0] === 'refresh') {
            await refreshModel(false);
          } else if (args[0]) {
            model = args.join(' ');
            console.log(`Model set to: ${model} (this session)`);
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

        case '/resume': {
          const s = await loadSession();
          if (s?.messages?.length) {
            messages = s.messages;
            console.log(`Loaded ${messages.length} messages into context.`);
          } else {
            console.log('No saved session.');
          }
          break;
        }

        case '/clear':
          messages = [];
          await saveSession({ messages: [], turn: 0 });
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
          console.log('Reloading boot.md + memory.md...');
          const boot = await loadBoot();
          const memory = await readMemory();
          let sys = SYSTEM_PROMPT + (boot ? '\n\n' + boot : '');
          if (memory) sys += `\n\n## Persistent Memory\n${memory}`;
          const pending = await loadTask();
          if (pending) sys += `\n\n## Resumed Task\nObjective: ${pending.objective} — continue this task.`;
          messages = [{ role: 'system', content: sys }];
          console.log('Reloaded.');
          break;
        }

        case '/exit':
        case '/quit':
          await saveSession({ messages: messages.slice(-20), turn: Date.now() });
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

        const response = await callLLMWithRetry(() => {
          if (abortRequested) throw new Error('Aborted by user');
          return callLLMApi(messages, toolsList, provider, model, apiKey, config.customProviders || {});
        });

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
            console.log(result?.success ? '✅' : '❌', JSON.stringify(result).slice(0, 200));

            messages.push({
              role: 'tool',
              content: JSON.stringify(result),
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
          console.log('\n' + response.content);
          messages.push({ role: 'assistant', content: response.content });
        } else {
          console.log('(model returned no content and no tool calls — try rephrasing)');
        }
        break;
      }
    } catch (error) {
      if (error.message === 'Aborted by user' || abortRequested) {
        abortedByUser = true;
      } else {
        // AUTO-RECOVERY: provider rejected the model (deprecation, retirement,
        // 404 model not found, 400 invalid model). Refetch the live list and
        // prompt a re-pick instead of failing the turn.
        const deprecationHit = error.status === 404
          || error.status === 400
          || /deprecat|not found|no longer|unsupported|invalid model|does not exist/i.test(error.message || '');
        if (deprecationHit && apiKey) {
          console.log(`\n⚠️  ${provider} rejected model "${model}" — likely deprecated. Refreshing model list...`);
          const refreshed = await refreshModel(false);
          if (refreshed && refreshed !== model) {
            console.log(`Retrying this turn with ${refreshed}...`);
            // Re-run the cycle with the new model by simulating a fresh turn
            // (remove the error message we would have pushed, retry once)
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

    if (abortedByUser) {
      console.log('\n⏹  Cycle stopped by user.');
      abortRequested = false;
    }
    if (rounds >= MAX_TOOL_ROUNDS) {
      console.log(`⚠️  Hit ${MAX_TOOL_ROUNDS} tool rounds — stopping to avoid a loop. Say "continue" to keep going.`);
    }

    // Save session after each turn
    await saveSession({ messages: messages.slice(-20), turn: Date.now() });
  }
}
