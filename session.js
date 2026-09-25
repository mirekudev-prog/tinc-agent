/**
 * TINC Session Manager - Session state and task persistence
 * All state lives in ~/.tinc (outside the repo).
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const DATA_DIR = path.join(os.homedir(), '.tinc');
const SESSION_FILE = path.join(DATA_DIR, 'session_state.json');
const TASK_FILE = path.join(DATA_DIR, 'current_task.json');

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function loadSession() {
  try {
    const content = await fs.readFile(SESSION_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') return { messages: [], turn: 0 };
    return { messages: [], turn: 0 };
  }
}

export async function saveSession(session) {
  await ensureDir();
  await fs.writeFile(SESSION_FILE, JSON.stringify(session, null, 2), 'utf-8');
}

export async function loadTask() {
  try {
    const content = await fs.readFile(TASK_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function saveTask(task) {
  await ensureDir();
  if (task) {
    await fs.writeFile(TASK_FILE, JSON.stringify(task, null, 2), 'utf-8');
  } else {
    await clearTask();
  }
}

export async function clearTask() {
  try {
    await fs.unlink(TASK_FILE);
  } catch {}
}

/**
 * Check for pending task on startup and return it for injection into context.
 */
export async function checkAndResumeTask() {
  const task = await loadTask();
  if (task?.objective) {
    console.log(`📋 Resuming task: ${task.objective}`);
    return task;
  }
  return null;
}
