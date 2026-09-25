/**
 * TINC Memory Handler - boot.md loader and persistent memory
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
