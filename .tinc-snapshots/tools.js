/**
 * TINC Tools - Read, Write, Edit, Bash, Memory, GitHub, Task, Web
 * Node.js built-ins only. Auto-pushes to GitHub on self-edits.
 */

import fs from 'fs/promises';
import { exec } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(os.homedir(), '.tinc');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.md');

// Safety module is imported lazily to avoid a cycle (safety -> config)
async function safety() {
  return await import('./safety.js');
}

const SELF_FILES = ['boot.md', 'tools.js', 'index.js', 'loop.js', 'memory.js', 'config.js', 'api.js', 'session.js', 'tui.js', 'package.json'];

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function run(cmd, opts = {}) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 30000, maxBuffer: 10 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
      resolve({ error: error ? error.message : null, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

export const tools = {
  read: {
    description: 'Read file contents (text). Use for code, configs, docs. For large files, use offset/limit.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read (relative to cwd or absolute)' },
        offset: { type: 'number', description: 'Line number to start from (1-based, optional)' },
        limit: { type: 'number', description: 'Max lines to read (optional)' }
      },
      required: ['path'],
      additionalProperties: false
    },
    async execute({ path: p, offset, limit }) {
      try {
        let content = await fs.readFile(p, 'utf-8');
        if (offset || limit) {
          const lines = content.split('\n');
          const start = (offset ? offset - 1 : 0);
          const end = limit ? start + limit : lines.length;
          content = lines.slice(start, end)
            .map((l, i) => `${start + i + 1}|${l}`)
            .join('\n');
        }
        const stat = await fs.stat(p);
        return { success: true, content, size: stat.size };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  write: {
    description: 'Create or overwrite a file with full content. For targeted changes to existing files, prefer edit.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write' },
        content: { type: 'string', description: 'Full content to write' }
      },
      required: ['path', 'content'],
      additionalProperties: false
    },
    async execute({ path: p, content }) {
      try {
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, content, 'utf-8');
        return { success: true, path: p, bytes: content.length };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  edit: {
    description: 'Edit a file by replacing text. oldText must match exactly. Replaces the FIRST occurrence by default; set replaceAll for every occurrence. Any edit size is allowed — small patches or full rewrites both work. Auto-commits and pushes to GitHub when editing TINC self files.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to edit' },
        oldText: { type: 'string', description: 'Exact text to find' },
        newText: { type: 'string', description: 'Replacement text' },
        replaceAll: { type: 'boolean', description: 'Replace all occurrences (default false = first occurrence)' }
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false
    },
    async execute({ path: p, oldText, newText, replaceAll = false }) {
      try {
        const content = await fs.readFile(p, 'utf-8');
        if (!content.includes(oldText)) {
          return { success: false, error: `oldText not found in ${p}` };
        }
        // NO artificial limits: first occurrence by default, all with replaceAll,
        // any size of change allowed — tiny tweak or full rewrite.
        const newContent = replaceAll
          ? content.split(oldText).join(newText)
          : content.replace(oldText, newText);

        await fs.writeFile(p, newContent, 'utf-8');

        // Auto-push for self files
        const isSelfFile = SELF_FILES.some(f => p === f || p.endsWith('/' + f) || p === path.join(__dirname, f));
        if (isSelfFile) {
          const g = await run('git rev-parse --is-inside-work-tree 2>/dev/null');
          if (!g.error) {
            await run('git add .');
            await run(`git commit -m "Self-update: edit ${p}"`);
            const push = await run('git push origin master');
            return { success: true, pushed: !push.error, pushError: push.error || undefined };
          }
        }
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  bash: {
    description: 'Execute a shell command and return stdout/stderr. 30s timeout. Use for builds, git, installs, running code.',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to execute' },
        cwd: { type: 'string', description: 'Working directory (optional, default: process cwd)' },
        timeout: { type: 'number', description: 'Timeout in ms (default 30000, max 120000)' }
      },
      required: ['command'],
      additionalProperties: false
    },
    async execute({ command, cwd, timeout }) {
      const result = await run(command, {
        cwd: cwd || undefined,
        timeout: Math.min(timeout || 30000, 120000)
      });
      return {
        success: !result.error,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error || undefined
      };
    }
  },

  memory: {
    description: 'Persistent memory across sessions. Read the whole file, or append a dated learning/preference/fact. Use append to store durable lessons.',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'append'], description: 'read = whole file, append = add entry' },
        content: { type: 'string', description: 'Entry text (append only)' }
      },
      required: ['action'],
      additionalProperties: false
    },
    async execute({ action, content }) {
      await ensureDataDir();
      try {
        if (action === 'read') {
          const c = await fs.readFile(MEMORY_FILE, 'utf-8').catch(() => '');
          return { success: true, content: c || '(memory empty)' };
        } else if (action === 'append') {
          if (!content) return { success: false, error: 'content required for append' };
          const timestamp = new Date().toISOString();
          await fs.appendFile(MEMORY_FILE, `\n## ${timestamp}\n${content}\n`, 'utf-8');
          return { success: true };
        }
        return { success: false, error: 'Invalid action. Use read or append.' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  github: {
    description: 'Git operations on the current repo: status, push, clone, verify.',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'push', 'clone', 'verify'], description: 'Git action' },
        message: { type: 'string', description: 'Commit message (for push)' }
      },
      required: ['action'],
      additionalProperties: false
    },
    async execute({ action, message }) {
      try {
        switch (action) {
          case 'status': {
            const remote = await run('git remote get-url origin');
            const branch = await run('git branch --show-current');
            const status = await run('git status --short');
            return {
              success: true,
              remote: remote.stdout.trim() || null,
              branch: branch.stdout.trim() || null,
              status: status.stdout.trim() || 'clean'
            };
          }
          case 'push': {
            if (!message) return { success: false, error: 'Commit message required' };
            const add = await run('git add .');
            if (add.error) return { success: false, error: 'git add failed: ' + add.error };
            const commit = await run(`git commit -m "${message.replace(/"/g, '\\"')}"`);
            if (commit.error) return { success: false, error: 'git commit failed: ' + commit.error, stderr: commit.stderr };
            const push = await run('git push origin master');
            return { success: !push.error, error: push.error || undefined, stderr: push.stderr };
          }
          case 'clone': {
            const clone = await run('git clone https://github.com/mirekudev-prog/tinc-agent.git tinc-self');
            return { success: !clone.error, error: clone.error || undefined };
          }
          case 'verify': {
            const v = await run('git rev-parse --is-inside-work-tree');
            return { success: !v.error, error: v.error ? 'Not a git repo' : undefined };
          }
          default:
            return { success: false, error: 'Unknown action' };
        }
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  task: {
    description: 'Save/load/clear the current task objective so work survives restarts. Save before long tasks; clear when done.',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'load', 'clear'], description: 'Task action' },
        objective: { type: 'string', description: 'Task objective (save only)' }
      },
      required: ['action'],
      additionalProperties: false
    },
    async execute({ action, objective }) {
      await ensureDataDir();
      const taskFile = path.join(DATA_DIR, 'current_task.json');
      try {
        if (action === 'save') {
          if (!objective) return { success: false, error: 'Objective required' };
          await fs.writeFile(taskFile, JSON.stringify({
            objective,
            timestamp: new Date().toISOString(),
            status: 'in_progress'
          }, null, 2), 'utf-8');
          return { success: true, message: 'Task saved' };
        } else if (action === 'load') {
          const c = await fs.readFile(taskFile, 'utf-8').catch(() => null);
          if (!c) return { success: false, error: 'No saved task' };
          return { success: true, task: JSON.parse(c) };
        } else if (action === 'clear') {
          await fs.unlink(taskFile).catch(() => {});
          return { success: true, message: 'Task cleared' };
        }
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  web: {
    description: 'Fetch a URL and return response body (text). Use for docs, APIs, and raw pages.',
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
        maxChars: { type: 'number', description: 'Max characters to return (default 8000)' }
      },
      required: ['url'],
      additionalProperties: false
    },
    async execute({ url: u, maxChars = 8000 }) {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 20000);
        const response = await fetch(u, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) TINC/0.2.0' }
        });
        clearTimeout(t);
        const status = response.status;
        let body = await response.text();
        if (body.length > maxChars) {
          body = body.slice(0, maxChars) + `\n...[truncated, ${body.length} total chars]`;
        }
        return { success: status < 400, status, body };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  web_search: {
    description: 'Search the web for current information (documentation, error messages, library usage, recent changes). Returns a synthesized answer plus source titles and links. ALWAYS use this before writing code against any API or library, and when answering questions about current events or versions.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' },
        search_depth: { type: 'string', enum: ['basic', 'advanced'], description: 'advanced = deeper, slower (default basic)' }
      },
      required: ['query'],
      additionalProperties: false
    },
    async execute({ query, search_depth = 'basic' }) {
      const SEARCH_URL = 'https://search-engine-8vjq.onrender.com/search';
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 90000); // engine can take ~60s
        const response = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(query)}&search_depth=${search_depth}`, {
          signal: controller.signal,
          headers: { 'User-Agent': 'TINC/0.2.0' }
        });
        clearTimeout(t);
        if (!response.ok) {
          return { success: false, error: `Search engine returned ${response.status}` };
        }
        const data = await response.json();
        const answer = data.answer || '(no answer)';
        const sources = (data.results || []).map(r => r.url || r.link || r.title).filter(Boolean).slice(0, 8);
        return {
          success: true,
          answer,
          sources,
          total_results: data.total_results,
          sources_used: data.sources_used
        };
      } catch (error) {
        return {
          success: false,
          error: error.name === 'AbortError' ? 'Search timed out after 90s' : error.message,
          hint: 'If search fails, use the web tool to fetch specific URLs directly.'
        };
      }
    }
  },

  termux: {
    description: 'Run Termux:API commands on the Android device (requires the Termux:API app). Actions: battery-status, clipboard-get, clipboard-set, notification, toast, vibrate, share, open-url, tts-speak, termux-info, wifi-status, location, sms-list, sms-send, call-log, contact-list, flashlight, volume, brightness, termux-wake-lock, termux-wake-unlock. If a command is missing, termux-api is not installed.',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Termux:API action name, e.g. battery-status' },
        args: { type: 'string', description: 'Arguments string passed to the command (e.g. for clipboard-set: the text; for notification: --title "X" --content "Y")' }
      },
      required: ['action'],
      additionalProperties: false
    },
    async execute({ action, args = '' }) {
      const cmd = `termux-${action} ${args}`.trim();
      const result = await run(cmd, { timeout: 15000 });
      if (result.error && /not found/i.test(result.error)) {
        return {
          success: false,
          error: 'Termux:API command not found. Install the Termux:API app (F-Droid/Play) and run: pkg install termux-api'
        };
      }
      return {
        success: !result.error,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error || undefined
      };
    }
  },

  snapshot: {
    description: 'Undo/redo file changes from the current turn, inspect them, or view pre-turn file versions. Actions: "undo" (revert all changes this turn — write, edit, AND bash), "redo" (re-apply undone changes), "changed" (list files changed this turn), "show" (view the pre-turn version of a file), "restore" (undo only specific files). Use when the user says "undo that", "revert", "put it back", "redo".',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['undo', 'redo', 'changed', 'show', 'restore'], description: 'Snapshot action' },
        path: { type: 'string', description: 'File path (for show / restore)' },
        files: { type: 'array', items: { type: 'string' }, description: 'File paths (for restore)' },
        steps: { type: 'number', description: 'Undo N turns back (undo only, default 1)' }
      },
      required: ['action'],
      additionalProperties: false
    },
    async execute({ action, path: p, files, steps = 1 }) {
      const s = await safety();
      const cwd = process.cwd();
      switch (action) {
        case 'undo': {
          const msg = await s.undoTurn(cwd, steps);
          return { success: !/failed|No snapshots/i.test(msg), message: msg };
        }
        case 'redo': {
          const msg = await s.redoTurn(cwd);
          return { success: !/failed/i.test(msg), message: msg };
        }
        case 'changed': {
          const changes = await s.getTurnChanges(cwd);
          return { success: true, ...changes };
        }
        case 'show': {
          if (!p) return { success: false, error: 'path required for show' };
          return await s.showSnapshotFile(cwd, p);
        }
        case 'restore': {
          const list = files || (p ? [p] : null);
          if (!list || !list.length) return { success: false, error: 'files or path required for restore' };
          return await s.restoreFiles(cwd, list);
        }
        default:
          return { success: false, error: 'Unknown action' };
      }
    }
  },

  share: {
    description: 'Share a file or text using the Android share sheet (Termux:API termux-share). text= text to share, or file= path to share. Optional title.',
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to share' },
        file: { type: 'string', description: 'File path to share' },
        title: { type: 'string', description: 'Title for the share sheet' },
        action: { type: 'string', enum: ['view', 'edit', 'send'], description: 'How to share (default send)' }
      },
      additionalProperties: false
    },
    async execute({ text, file, title, action }) {
      let cmd = 'termux-share';
      if (action) cmd += ` --action ${action}`;
      if (title) cmd += ` --title ${JSON.stringify(title)}`;
      if (file) {
        cmd += ` ${JSON.stringify(file)}`;
      } else if (text) {
        cmd += ` ${JSON.stringify(text)}`;
      } else {
        return { success: false, error: 'Provide text or file' };
      }
      const result = await run(cmd, { timeout: 30000 });
      return {
        success: !result.error,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error || undefined
      };
    }
  }
};
