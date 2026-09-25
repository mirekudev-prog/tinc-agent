/**
 * TINC Session Manager - Session resumption and state persistence
 */

import fs from 'fs/promises';
import { execSync } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(execSync);

const SESSION_FILE = 'session_state.json';
const TASK_FILE = 'current_task.json';

export async function loadSession() {
  try {
    const content = await fs.readFile('session_state.json', 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { messages: [], turn: 0 };
    }
    throw error;
  }
}

export async function saveSession(messages) {
  const session = {
    messages,
    turn: Date.now()
  };
  await fs.writeFile('session_state.json', JSON.stringify(session, null, 2), 'utf-8');
}

export async function loadTask() {
  try {
    const content = await fs.readFile('current_task.json', 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function saveTask(task) {
  if (task) {
    await fs.writeFile('current_task.json', JSON.stringify(task, null, 2), 'utf-8');
  } else {
    try {
      await fs.unlink('current_task.json');
    } catch {}
  }
}

export async function clearTask() {
  try {
    await fs.unlink('current_task.json');
  } catch {}
}

/**
 * Self-update sequence - saves current task, applies edits, commits, pushes, reloads
 */
export async function selfUpdateAndReload(editPath, editDescription) {
  // a) Save current objective/task
  const task = {
    timestamp: new Date().toISOString(),
    description: editDescription,
    objective: 'Self-update in progress'
  };
  await fs.writeFile('current_task.json', JSON.stringify(task, null, 2), 'utf-8');
  
  // b) Apply edits (already done by caller via edit tool)
  
  // c) Commit and push
  try {
    await execAsync('git add .');
    await execAsync(`git commit -m "Self-update: ${editDescription}"`);
    await execAsync('git push origin master');
  } catch (gitError) {
    console.warn('Git push failed:', gitError.message);
  }
  
  // d) Trigger reload
  console.log('Reloading...');
  
  // The reload will happen when the loop restarts
  // We can signal this by throwing a special error or setting a flag
  throw new Error('RELOAD_REQUESTED');
}

/**
 * Check for pending task on startup and resume if found
 */
export async function checkAndResumeTask() {
  const task = await fs.readFile('current_task.json', 'utf-8').catch(() => null);
  if (task) {
    try {
      const taskData = JSON.parse(task);
      console.log('📋 Resuming task:', taskData.description);
      return taskData;
    } catch {}
  }
  return null;
}