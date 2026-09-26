/**
 * TINC Selector — raw-mode arrow-key list picker (Hermes-style)
 * Zero dependencies. Suspend the readline interface first (raw mode
 * takes over stdin), render an inline list with ↑/↓ highlighting,
 * Enter selects, Esc/q/Ctrl+C cancels. Falls back to a printed list
 * (return -2) when stdin is not a TTY, so piped runs keep working.
 */

const ESC = '\x1b';
const CSI = '\x1b[';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

/**
 * Interactive inline selector.
 * @param {string} title   printed above the list
 * @param {Array<{label, hint}>} items
 * @param {Object} opts { startIndex, suspendRl }  suspendRl = readline interface to pause
 * @returns selected index, -1 = cancel, -2 = non-TTY (caller falls back)
 */
export async function selectFromList(title, items, opts = {}) {
  if (items.length === 0) return -1;

  // Piped / non-interactive stdin: caller handles typed input
  if (!process.stdin.isTTY) {
    console.log(`\n${title}`);
    items.forEach((it, i) => console.log(`  ${i + 1}. ${it.label}${it.hint ? '  — ' + it.hint : ''}`));
    return -2;
  }

  const rl = opts.suspendRl;
  const listeners = rl ? rl.listeners('line') : [];
  const closeListeners = rl ? rl.listeners('close') : [];
  if (rl) {
    // Detach readline's stdin consumers so raw-mode bytes reach us alone
    for (const l of listeners) rl.removeListener('line', l);
    for (const l of closeListeners) rl.removeListener('close', l);
    rl.pause();
  }

  const startIndex = Math.max(0, Math.min(opts.startIndex || 0, items.length - 1));
  let index = startIndex;

  const wasRaw = process.stdin.isRaw || false;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write(HIDE_CURSOR);

  const renderList = (first) => {
    if (!first) {
      process.stdout.write(`\x1b[${items.length + 1}A`); // back up over old block
    }
    process.stdout.write('\x1b[J'); // clear to end
    process.stdout.write(`\x1b[1m${title}\x1b[0m  \x1b[90m(↑/↓ select · Enter confirm · Esc cancel)\x1b[0m\n`);
    items.forEach((it, i) => {
      const selected = i === index;
      const pointer = selected ? '\x1b[92m❯\x1b[0m' : ' ';
      const label = selected ? `\x1b[92m\x1b[1m${it.label}\x1b[0m` : it.label;
      const hint = it.hint ? `  \x1b[90m${it.hint}\x1b[0m` : '';
      process.stdout.write(`${pointer} ${label}${hint}\n`);
    });
  };

  renderList(true);

  try {
    return await new Promise((resolve) => {
      let buffer = '';
      const onData = (chunk) => {
        buffer += chunk.toString('utf-8');

        if (buffer.startsWith(ESC)) {
          if (buffer.length >= 3 && buffer.startsWith(CSI)) {
            const key = buffer[2];
            buffer = '';
            if (key === 'A') { // up
              index = (index - 1 + items.length) % items.length;
              renderList(false);
            } else if (key === 'B') { // down
              index = (index + 1) % items.length;
              renderList(false);
            }
            return;
          }
          if (buffer.length >= 2) { // lone Esc = cancel
            cleanup(-1);
            return;
          }
          return; // incomplete sequence
        }

        const key = buffer;
        buffer = '';
        if (key === '\r' || key === '\n') {
          cleanup(index);
        } else if (key === '\x03') { // Ctrl+C
          cleanup(-1);
        } else if (key === 'q') {
          cleanup(-1);
        } else if (key >= '1' && key <= '9') {
          const n = parseInt(key) - 1;
          if (n < items.length) cleanup(n);
        }
      };

      const cleanup = (result) => {
        process.stdin.removeListener('data', onData);
        try { process.stdin.setRawMode(wasRaw); } catch {}
        process.stdout.write(SHOW_CURSOR);
        process.stdin.pause();

        // Reattach readline
        if (rl) {
          for (const l of listeners) rl.on('line', l);
          for (const l of closeListeners) rl.on('close', l);
          rl.resume();
        }

        if (result >= 0) {
          process.stdout.write('\n');
        } else if (result === -1) {
          console.log('\n(cancelled)');
        }
        resolve(result);
      };

      process.stdin.on('data', onData);
    });
  } catch (err) {
    // Emergency cleanup — never leave the terminal in raw mode
    try { process.stdin.setRawMode(wasRaw); } catch {}
    process.stdout.write(SHOW_CURSOR);
    if (rl) {
      for (const l of listeners) rl.on('line', l);
      for (const l of closeListeners) rl.on('close', l);
      rl.resume();
    }
    throw err;
  }
}

