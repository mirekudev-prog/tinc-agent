/**
 * TINC Memory Handler - boot.md loader, persistent memory, AGENTS.md
 * memory.md lives in ~/.tinc (outside the repo, gitignored by design).
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOOT_FILE = path.join(__dirname, 'boot.md');
const DATA_DIR = path.join(os.homedir(), '.tinc');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.md');

// Project context: AGENTS.md in the cwd (OpenCode/Pi convention).
// Loaded once per session start, cached by absolute path.
const projectContextCache = new Map();

export async function loadProjectContext(cwd = process.cwd()) {
  const dir = path.resolve(cwd);
  if (projectContextCache.has(dir)) return projectContextCache.get(dir);

  const candidates = [
    path.join(dir, 'AGENTS.md'),
    path.join(dir, 'CLAUDE.md'),
    path.join(dir, '.tinc', 'AGENTS.md')
  ];

  let content = null;
  let source = null;
  for (const c of candidates) {
    try {
      const raw = await fs.readFile(c, 'utf-8');
      if (raw.trim()) { content = raw; source = path.basename(path.dirname(c)) === '.tinc' ? '.tinc/AGENTS.md' : path.basename(c); break; }
    } catch {}
  }

  const result = content ? { content, source } : null;
  projectContextCache.set(dir, result);
  return result;
}

export async function loadBoot() {
  try {
    return await fs.readFile(BOOT_FILE, 'utf-8');
  } catch {
    return '';
  }
}

export async function appendMemory(content) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const timestamp = new Date().toISOString();
  const entry = `\n## ${timestamp}\n${content}\n`;
  await fs.appendFile(MEMORY_FILE, entry, 'utf-8');
}

export async function readMemory() {
  try {
    const content = await fs.readFile(MEMORY_FILE, 'utf-8');
    // Cap memory injection to the last 3000 chars to protect context
    if (content.length > 3000) {
      return '...[older entries trimmed]\n' + content.slice(-3000);
    }
    return content;
  } catch {
    return '';
  }
}
