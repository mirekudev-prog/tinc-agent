/**
 * TINC Session Manager - Multi-session store, task persistence
 * All state lives in ~/.tinc (outside the repo).
 *
 * Sessions live in ~/.tinc/sessions/<id>.json with metadata:
 *   { id, name, created, updated, messages, turn, task? }
 * The ACTIVE session pointer is ~/.tinc/active_session (holds an id).
 * Legacy ~/.tinc/session_state.json is migrated on first load.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const DATA_DIR = path.join(os.homedir(), '.tinc');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const ACTIVE_FILE = path.join(DATA_DIR, 'active_session');
const LEGACY_FILE = path.join(DATA_DIR, 'session_state.json');
const TASK_FILE = path.join(DATA_DIR, 'current_task.json');

async function ensureDirs() {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
}

export function newSessionId() {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------- ACTIVE POINTER ----------

async function getActiveId() {
  try {
    const id = (await fs.readFile(ACTIVE_FILE, 'utf-8')).trim();
    return id || null;
  } catch {
    return null;
  }
}

async function setActiveId(id) {
  await ensureDirs();
  await fs.writeFile(ACTIVE_FILE, id, 'utf-8');
}

// ---------- SESSION CRUD ----------

function sessionPath(id) {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

export async function listSessions() {
  await ensureDirs();
  const files = await fs.readdir(SESSIONS_DIR).catch(() => []);
  const sessions = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await fs.readFile(path.join(SESSIONS_DIR, f), 'utf-8'));
      sessions.push({
        id: raw.id || f.replace('.json', ''),
        name: raw.name || 'untitled',
        created: raw.created,
        updated: raw.updated,
        messageCount: (raw.messages || []).length,
        active: false
      });
    } catch {}
  }
  sessions.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const activeId = await getActiveId();
  const active = sessions.find(s => s.id === activeId);
  if (active) active.active = true;
  return sessions;
}

export async function loadSession(id) {
  await ensureDirs();
  // No id → active session; migrate legacy if nothing exists yet
  if (!id) {
    id = await getActiveId();
    if (id) {
      try {
        const raw = JSON.parse(await fs.readFile(sessionPath(id), 'utf-8'));
        return raw;
      } catch {}
    }
    // Migrate legacy single-session state
    try {
      const legacy = JSON.parse(await fs.readFile(LEGACY_FILE, 'utf-8'));
      if (legacy?.messages?.length) {
        const migrated = await createSession(null, legacy.messages);
        return migrated;
      }
    } catch {}
    return { id: null, messages: [], turn: 0 };
  }
  try {
    return JSON.parse(await fs.readFile(sessionPath(id), 'utf-8'));
  } catch {
    return { id: null, messages: [], turn: 0 };
  }
}

export async function saveSession(session) {
  await ensureDirs();
  if (!session.id) session.id = newSessionId();
  if (!session.created) session.created = Date.now();
  session.updated = Date.now();
  await fs.writeFile(sessionPath(session.id), JSON.stringify(session, null, 2), 'utf-8');
  await setActiveId(session.id);
  return session;
}

export async function createSession(name, messages = []) {
  const session = {
    id: newSessionId(),
    name: name || null,           // null → auto "untitled" until /rename
    created: Date.now(),
    updated: Date.now(),
    messages,
    turn: Date.now()
  };
  await saveSession(session);
  return session;
}

export async function renameSession(id, name) {
  const s = await loadSession(id);
  if (!s.id) return null;
  s.name = name;
  s.updated = Date.now();
  await fs.writeFile(sessionPath(s.id), JSON.stringify(s, null, 2), 'utf-8');
  return s;
}

export async function deleteSession(id) {
  try {
    await fs.unlink(sessionPath(id));
  } catch {}
  // If the deleted one was active, clear the pointer
  const activeId = await getActiveId();
  if (activeId === id) {
    try { await fs.unlink(ACTIVE_FILE); } catch {}
  }
}

// ---------- TASK (per active session) ----------

export async function loadTask() {
  try {
    const content = await fs.readFile(TASK_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function saveTask(task) {
  await ensureDirs();
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
