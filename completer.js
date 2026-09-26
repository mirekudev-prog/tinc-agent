/**
 * TINC Completer — slash-command + file-path autocomplete
 * Raw-ANSI, zero dependencies. Works with plain readline line editing:
 * type "/" → list commands filtered as you type, Tab cycles completions.
 */

import { execSync } from 'child_process';

const SLASH = [
  '/help', '/model', '/model list', '/model refresh',
  '/provider', '/login', '/context', '/compact',
  '/resume', '/clear', '/task', '/task clear',
  '/reload', '/stop', '/exit'
];

export function createCompleter() {
  function complete(partial) {
    // Slash-command completion
    if (partial.startsWith('/')) {
      const trimmed = partial.trim();
      const matches = SLASH.filter(c => c.startsWith(trimmed));
      return { matches: matches.length ? matches : SLASH, type: 'cmd' };
    }
    // File-path completion (last word only)
    const lastSpace = partial.lastIndexOf(' ');
    const frag = partial.slice(lastSpace + 1);
    if (!frag) return { matches: [], type: 'path' };
    try {
      const out = execSync(`compgen -f -- ${JSON.stringify(frag)}`, { encoding: 'utf-8', timeout: 2000 });
      const matches = out.split('\n').filter(Boolean).map(m => partial.slice(0, lastSpace + 1) + m);
      return { matches, type: 'path' };
    } catch {
      return { matches: [], type: 'path' };
    }
  }

  return { complete };
}

