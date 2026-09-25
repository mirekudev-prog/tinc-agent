/**
 * TINC Memory Handler - Handles boot.md and memory.md
 */

import fs from 'fs/promises';

const BOOT_FILE = 'boot.md';
const MEMORY_FILE = 'memory.md';

export async function loadBoot() {
  try {
    const content = await fs.readFile(BOOT_FILE, 'utf-8');
    return content;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return ''; // Return empty if boot.md doesn't exist yet
    }
    throw error;
  }
}

export async function appendMemory(content) {
  const timestamp = new Date().toISOString();
  const entry = `\n## ${timestamp}\n${content}\n`;
  await fs.appendFile('memory.md', entry, 'utf-8');
}

export async function readMemory() {
  try {
    const content = await fs.readFile('memory.md', 'utf-8');
    return content;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return ''; // Return empty if memory.md doesn't exist yet
    }
    throw error;
  }
}