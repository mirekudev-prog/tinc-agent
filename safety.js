/**
 * TINC Safety Net — journal-based undo/redo for agent file changes
 *
 * Design:
 *   - Before each turn: snapshot the tree into a shadow git repo (as before).
 *     This HEAD is exactly "state before this turn".
 *   - During the turn: every successful write/edit tool call appends the
 *     path to the turn journal (last-turn file: .tinc-snapshots/journal.json).
 *   - /undo: park current versions of journaled files into redo-files/,
 *     then restore each journaled path from the snapshot HEAD — or delete
 *     it if it didn't exist before the turn (agent-created file).
 *   - /redo: copy the parked versions back.
 *
 * Precise: only files the agent's write/edit tools touched are reverted.
 * (Changes made purely via bash are not journaled — known limitation.)
 * User git repos are never touched. Best-effort: failures never break the loop.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const SNAP_DIR = '.tinc-snapshots';
const JOURNAL_FILE = path.join(SNAP_DIR, 'journal.json');
const REDO_DIR = path.join(SNAP_DIR, 'redo-files');
const EXCLUDES = [
  '.git', '.tinc-snapshots', 'node_modules', 'dist', 'build',
  '.cache', 'video_frames', '__pycache__', '.venv', 'venv'
];

async function run(cmd, cwd) {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd, timeout: 30000, maxBuffer: 20 * 1024 * 1024
    });
    return { ok: true, stdout: stdout || '', stderr: stderr || '' };
  } catch (e) {
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || String(e.message) };
  }
}

function snapPath(cwd) {
  return path.join(cwd, SNAP_DIR);
}

async function ensureShadowRepo(cwd) {
  const sp = snapPath(cwd);
  await fs.mkdir(sp, { recursive: true });
  const r = await run('git rev-parse --is-inside-work-tree', sp);
  if (!r.ok) {
    await run('git init -q', sp);
    await run('git config user.email tinc@local', sp);
    await run('git config user.name TINC-Snapshots', sp);
  }
  return sp;
}

function excludeArgs() {
  return EXCLUDES.map(e => `--exclude='${e}'`).join(' ');
}

// ---------- JOURNAL ----------

async function loadJournal(cwd) {
  try {
    return JSON.parse(await fs.readFile(path.join(cwd, JOURNAL_FILE), 'utf-8'));
  } catch {
    return [];
  }
}

async function saveJournal(cwd, paths) {
  const sp = snapPath(cwd);
  await fs.mkdir(sp, { recursive: true });
  await fs.writeFile(path.join(cwd, JOURNAL_FILE), JSON.stringify(paths, null, 2), 'utf-8');
}

/**
 * Called at the START of every user turn: clears the journal (new turn)
 * and snapshots the tree. The snapshot commits only when files changed.
 */
export async function snapshotBeforeTurn(cwd, userPrompt) {
  try {
    await ensureShadowRepo(cwd);
    await saveJournal(cwd, []);           // fresh journal for this turn
    const sp = snapPath(cwd);
    await run("find . -mindepth 1 -maxdepth 1 -not -name .git -exec rm -rf {} +", sp);
    const tar = await run(`tar cf - ${excludeArgs()} . | tar xf - -C ${JSON.stringify(sp)}`, cwd);
    if (!tar.ok) return false;
    await run('git add -A', sp);
    const status = await run('git status --porcelain', sp);
    if (!status.stdout.trim()) return false;
    const msg = (userPrompt || 'turn').slice(0, 100).replace(/["`$\\]/g, "'");
    const commit = await run(`git commit -q -m ${JSON.stringify(msg)}`, sp);
    return commit.ok;
  } catch {
    return false;
  }
}

/**
 * Called after every SUCCESSFUL write/edit tool execution — records the
 * path in the current turn's journal. Must be called from tools or loop.
 */
export async function trackFileChange(cwd, filePath) {
  try {
    const journal = await loadJournal(cwd);
    if (!journal.includes(filePath)) journal.push(filePath);
    await saveJournal(cwd, journal);
  } catch {}
}

// ---------- UNDO / REDO ----------

/**
 * Undo the last turn's tracked file changes.
 */
export async function undoTurn(cwd) {
  try {
    const sp = snapPath(cwd);
    const exists = await fs.stat(sp).catch(() => null);
    if (!exists) return 'No snapshots yet — nothing to undo.';

    const journal = await loadJournal(cwd);
    if (!journal.length) {
      return 'No tracked file changes in the last turn (bash-only changes are not journaled).';
    }

    const head = await run('git rev-parse HEAD', sp);
    if (!head.ok) return 'Snapshot repo has no commits yet.';
    const headSha = head.stdout.trim();

    // Park current versions for redo
    const redoBase = path.join(cwd, REDO_DIR);
    await fs.mkdir(redoBase, { recursive: true });

    let undone = 0;
    let deleted = 0;
    const report = [];

    for (const rel of journal) {
      const abs = path.resolve(cwd, rel);
      // Security: only revert paths inside the cwd
      if (!abs.startsWith(path.resolve(cwd))) continue;

      const existedBefore = await run(`git cat-file -e ${JSON.stringify(headSha + ':' + rel)} 2>/dev/null`, sp);

      // Park the current version (if it exists)
      try {
        const cur = await fs.readFile(abs);
        const parkPath = path.join(redoBase, rel);
        await fs.mkdir(path.dirname(parkPath), { recursive: true });
        await fs.writeFile(parkPath, cur);
      } catch { /* file doesn't currently exist — nothing to park */ }

      if (existedBefore.ok) {
        // Restore the pre-turn version
        const show = await run(`git show ${JSON.stringify(headSha + ':' + rel)}`, sp);
        if (show.ok) {
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, show.stdout, 'utf-8');
          undone++;
          report.push(`restored ${rel}`);
        }
      } else {
        // Agent created this file — remove it
        try {
          await fs.unlink(abs);
          deleted++;
          report.push(`deleted ${rel}`);
        } catch {}
      }
    }

    if (undone === 0 && deleted === 0) {
      return 'Nothing to undo (no restorable changes found).';
    }

    return `↩️  Undone: ${undone} restored, ${deleted} deleted.\n    ${report.slice(0, 6).join('\n    ')}${report.length > 6 ? `\n    ...+${report.length - 6} more` : ''}\n    /redo to re-apply.`;
  } catch (e) {
    return 'Undo failed: ' + (e.message || e);
  }
}

/**
 * Redo: re-apply the parked (undone) versions.
 */
export async function redoTurn(cwd) {
  try {
    const redoBase = path.join(cwd, REDO_DIR);
    const exists = await fs.stat(redoBase).catch(() => null);
    if (!exists) return 'Nothing to redo.';

    let count = 0;
    async function copyDir(srcDir, destDir) {
      const entries = await fs.readdir(srcDir, { withFileTypes: true });
      for (const entry of entries) {
        const s = path.join(srcDir, entry.name);
        const d = path.join(destDir, entry.name);
        if (entry.isDirectory()) {
          await fs.mkdir(d, { recursive: true });
          await copyDir(s, d);
        } else {
          await fs.mkdir(path.dirname(d), { recursive: true });
          await fs.copyFile(s, d);
          count++;
        }
      }
    }
    await copyDir(redoBase, cwd);
    await fs.rm(redoBase, { recursive: true, force: true });
    return count ? `↪️  Redone — ${count} file(s) re-applied.` : 'Nothing to redo.';
  } catch (e) {
    return 'Redo failed: ' + (e.message || e);
  }
}

/**
 * Recent snapshots for /undo list.
 */
export async function listSnapshots(cwd, limit = 5) {
  try {
    const sp = snapPath(cwd);
    const exists = await fs.stat(sp).catch(() => null);
    if (!exists) return [];
    const log = await run(`git log --format=%h|%s|%ct -n ${limit + 1}`, sp);
    if (!log.ok) return [];
    return log.stdout.trim().split('\n').filter(Boolean).map(l => {
      const [sha, msg, t] = l.split('|');
      return { sha, msg, at: new Date(parseInt(t) * 1000) };
    });
  } catch {
    return [];
  }
}
