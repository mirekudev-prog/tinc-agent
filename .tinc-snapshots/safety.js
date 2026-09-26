/**
 * TINC Safety Net — snapshot-based undo/redo covering ALL tools
 * (write, edit, AND bash — rm, sed -i, echo >, mv, package managers...)
 *
 * Design:
 *   - Before every turn: sync the tree into the shadow repo and commit.
 *     HEAD is always "state at the start of the current turn".
 *   - /undo: re-sync the tree into the shadow worktree (uncommitted), diff
 *     against HEAD → every file changed this turn by ANY tool. Park current
 *     versions in redo-files/, restore pre-turn versions, delete files that
 *     didn't exist before. No journal needed — the diff IS the journal.
 *   - /undo N: walk back N snapshots for multi-step undo.
 *   - /redo: re-apply parked versions.
 *   - The agent itself can undo via the `snapshot` tool (action: undo /
 *     redo / changed / show) — so "undo that" in plain language works.
 *
 * User git repos are never touched. Best-effort: failures never break the loop.
 */

import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const SNAP_DIR = '.tinc-snapshots';
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

/** Copy the real working tree into the shadow worktree (uncommitted). */
async function syncTreeIntoShadow(cwd) {
  const sp = snapPath(cwd);
  await run("find . -mindepth 1 -maxdepth 1 -not -name .git -exec rm -rf {} +", sp);
  const tar = await run(`tar cf - ${excludeArgs()} . | tar xf - -C ${JSON.stringify(sp)}`, cwd);
  return tar.ok;
}

/**
 * START of every user turn: sync + commit if the tree changed.
 * HEAD = state before this turn begins.
 */
export async function snapshotBeforeTurn(cwd, userPrompt) {
  try {
    await ensureShadowRepo(cwd);
    if (!(await syncTreeIntoShadow(cwd))) return false;
    const sp = snapPath(cwd);
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
 * Files changed since snapshot HEAD — everything this turn touched via
 * ANY tool (write, edit, bash). Syncs the tree first.
 * Returns { changed, created, deleted } as relative paths.
 */
export async function getTurnChanges(cwd) {
  try {
    await ensureShadowRepo(cwd);
    await syncTreeIntoShadow(cwd);
    const sp = snapPath(cwd);

    const head = await run('git rev-parse HEAD', sp);
    if (!head.ok) return { changed: [], created: [], deleted: [] };

    const st = await run('git status --porcelain', sp);
    const changed = [];
    const created = [];
    const deleted = [];

    for (const line of st.stdout.split('\n')) {
      if (!line.trim()) continue;
      const statusCode = line.slice(0, 2);
      let p = line.slice(3).trim();
      if (p.includes(' -> ')) {              // renames: track both sides
        const [oldP, newP] = p.split(' -> ').map(s => s.replace(/^"|"$/g, ''));
        deleted.push(oldP);
        created.push(newP);
        changed.push(newP);
        continue;
      }
      p = p.replace(/^"|"$/g, '');
      if (!p) continue;
      if (statusCode.includes('D')) deleted.push(p);
      else if (statusCode.includes('?')) created.push(p);
      else changed.push(p);
    }
    return {
      changed: [...new Set(changed)],
      created: [...new Set(created)],
      deleted: [...new Set(deleted)]
    };
  } catch {
    return { changed: [], created: [], deleted: [] };
  }
}

async function fileInHead(cwd, rel) {
  const sp = snapPath(cwd);
  const r = await run(`git cat-file -e ${JSON.stringify('HEAD:' + rel)} 2>/dev/null`, sp);
  return r.ok;
}

async function restoreFromHead(cwd, rel) {
  const sp = snapPath(cwd);
  const show = await run(`git show ${JSON.stringify('HEAD:' + rel)}`, sp);
  if (!show.ok) return false;
  const abs = path.resolve(cwd, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, show.stdout, 'utf-8');
  return true;
}

/** Park the current version of a file (if it exists) for /redo. */
async function parkForRedo(cwd, rel) {
  const abs = path.resolve(cwd, rel);
  const parkPath = path.join(cwd, REDO_DIR, rel);
  try {
    const cur = await fs.readFile(abs);
    await fs.mkdir(path.dirname(parkPath), { recursive: true });
    await fs.writeFile(parkPath, cur);
    return true;
  } catch {
    return false;
  }
}

/**
 * Undo changes since snapshot HEAD. Covers every tool including bash.
 * @param {number} steps  walk back N snapshots (default 1)
 */
export async function undoTurn(cwd, steps = 1) {
  try {
    const sp = snapPath(cwd);
    const exists = await fs.stat(sp).catch(() => null);
    if (!exists) return 'No snapshots yet — nothing to undo.';

    if (steps > 1) {
      const count = await run('git rev-list --count HEAD', sp);
      const n = parseInt(count.stdout?.trim());
      if (isNaN(n) || n < steps) return `Only ${isNaN(n) ? 0 : n} snapshot(s) — can't undo ${steps}.`;
      await run(`git reset -q --hard HEAD~${steps - 1}`, sp);
    }

    const { changed, created, deleted } = await getTurnChanges(cwd);
    const all = [...new Set([...changed, ...created, ...deleted])];
    if (!all.length) return 'No file changes to undo in the last turn.';

    const redoBase = path.join(cwd, REDO_DIR);
    await fs.mkdir(redoBase, { recursive: true });

    let restored = 0;
    let removed = 0;
    const report = [];

    for (const rel of all) {
      const abs = path.resolve(cwd, rel);
      if (!abs.startsWith(path.resolve(cwd))) continue;   // stay inside cwd

      await parkForRedo(cwd, rel);

      if (await fileInHead(cwd, rel)) {
        if (await restoreFromHead(cwd, rel)) {
          restored++;
          report.push(`restored ${rel}`);
        }
      } else {
        try {
          await fs.unlink(abs);
          removed++;
          report.push(`deleted ${rel}`);
        } catch {}
      }
    }

    if (!restored && !removed) return 'Nothing restorable found.';
    return `↩️  Undone: ${restored} restored, ${removed} deleted.\n    ${report.slice(0, 6).join('\n    ')}${report.length > 6 ? `\n    ...+${report.length - 6} more` : ''}\n    /redo to re-apply.`;
  } catch (e) {
    return 'Undo failed: ' + (e.message || e);
  }
}

/**
 * Undo specific files only (for the agent's snapshot tool).
 */
export async function restoreFiles(cwd, files) {
  try {
    const redoBase = path.join(cwd, REDO_DIR);
    await fs.mkdir(redoBase, { recursive: true });

    let restored = 0;
    let removed = 0;
    const report = [];
    for (const rel of files) {
      const abs = path.resolve(cwd, rel);
      if (!abs.startsWith(path.resolve(cwd))) continue;
      await parkForRedo(cwd, rel);
      if (await fileInHead(cwd, rel)) {
        if (await restoreFromHead(cwd, rel)) { restored++; report.push(`restored ${rel}`); }
      } else {
        try {
          await fs.unlink(abs);
          removed++;
          report.push(`deleted ${rel}`);
        } catch {}
      }
    }
    return { success: true, restored, removed, report };
  } catch (e) {
    return { success: false, error: String(e.message || e) };
  }
}

/**
 * Show the pre-turn (snapshot HEAD) version of a file.
 */
export async function showSnapshotFile(cwd, rel) {
  const sp = snapPath(cwd);
  if (!(await fileInHead(cwd, rel))) {
    return { success: false, error: `${rel} does not exist in the pre-turn snapshot` };
  }
  const show = await run(`git show ${JSON.stringify('HEAD:' + rel)}`, sp);
  return { success: show.ok, content: show.stdout, error: show.ok ? undefined : show.stderr };
}

/**
 * Redo: re-apply parked (undone) versions.
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
