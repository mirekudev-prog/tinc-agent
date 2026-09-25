/**
 * TINC TUI - Lightweight Terminal User Interface for Termux
 * NO alternate screen buffer - native touch scrolling works
 * NO heavy UI libraries - raw ANSI escape codes only
 * 
 * Three zones:
 *   TOP    - Status bar (1 line)
 *   MIDDLE - Output stream (scrollable, native touch)
 *   BOTTOM - Input prompt (always at bottom)
 */

const STATUS_BAR_HEIGHT = 1;
const INPUT_LINE_HEIGHT = 1;

export function createTUI() {
  let outputLines = [];
  const MAX_OUTPUT_LINES = 500; // Cap for memory, but terminal scroll handles rest

  function scrollUp(lines) {
    // Scroll content up without clearing terminal
    for (let i = 0; i < lines; i++) {
      process.stdout.write('\x1b[1A'); // Cursor up one line
    }
  }

  function scrollDown(lines) {
    for (let i = 0; i < lines; i++) {
      process.stdout.write('\x1b[1B'); // Cursor down one line
    }
  }

  function moveTo(row, col) {
    process.stdout.write(`\x1b[${row};${col}H`);
  }

  function clearLine() {
    process.stdout.write('\x1b[2K'); // Clear entire line
  }

  function eraseToEnd() {
    process.stdout.write('\x1b[K'); // Erase from cursor to end of line
  }

  function renderStatus(status) {
    // Status bar at top - overwrite in place
    moveTo(1, 1);
    clearLine();
    
    const modelInfo = status.model ? `\x1b[94m${status.model}\x1b[0m` : '\x1b[90mno model\x1b[0m';
    const providerInfo = status.provider ? `\x1b[96m${status.provider}\x1b[0m` : '\x1b[90mno provider\x1b[0m';
    const tokenInfo = status.tokens ? `\x1b[93mtokens: ${status.tokens}\x1b[0m` : '';
    const taskInfo = status.task ? `\x1b[92m${status.task}\x1b[0m` : '\x1b[90midle\x1b[0m';
    
    const statusLine = `TINC | Model: ${modelInfo} | Provider: ${providerInfo} | ${tokenInfo} | ${taskInfo}`;
    
    // Pad to full width
    process.stdout.write(statusLine + '\x1b[K');
    
    // Move cursor to just below status bar
    moveTo(2, 1);
  }

  function pushOutput(text) {
    // Add text to output buffer and render it below status bar
    const lines = text.split('\n');
    
    for (const line of lines) {
      outputLines.push(line);
      if (outputLines.length > MAX_OUTPUT_LINES) {
        outputLines.shift();
      }
      
      // Write the line below the status bar (at current cursor position)
      process.stdout.write(line + '\n');
    }
  }

  function render(outputText, inputPrompt = '> ') {
    if (outputText) {
      pushOutput(outputText);
    }
    
    // Cursor is now somewhere in the output. Move to bottom for input.
    // We don't know exact position, so use a marker approach:
    // Actually, we just write the input prompt and let readline handle it.
    // The key is: readline's prompt() will handle positioning.
    
    // For the TUI to work with readline, we need to:
    // 1. Let readline create its own prompt line
    // 2. After each render, move cursor to below all output
    
    // Simpler approach: just write output and let readline prompt be the bottom
    return;
  }

  function updateStatusBar(status) {
    // Redraw just the status bar without disturbing rest of screen
    const currentRow = process.stdout.rows || 24;
    
    // Save current cursor position
    process.stdout.write('\x1b[s');
    
    // Move to top and redraw
    moveTo(1, 1);
    clearLine();
    
    const modelInfo = status.model ? `\x1b[94m${status.model}\x1b[0m` : '\x1b[90mno model\x1b[0m';
    const providerInfo = status.provider ? `\x1b[96m${status.provider}\x1b[0m` : '\x1b[90mno provider\x1b[0m';
    const tokenInfo = status.tokens ? `\x1b[93mtokens: ${status.tokens}\x1b[0m` : '';
    const taskInfo = status.task ? `\x1b[92m${status.task}\x1b[0m` : '\x1b[90m idle\x1b[0m';
    const thinkInfo = status.thinking ? `\x1b[95m[THINKING]\x1b[0m` : '';
    
    const statusLine = `TINC | ${thinkInfo} Model: ${modelInfo} | Provider: ${providerInfo} | ${tokenInfo} | ${taskInfo}`;
    
    process.stdout.write(statusLine + '\x1b[K');
    
    // Restore cursor to where it was
    process.stdout.write('\x1b[u');
  }

  function clearScreen() {
    process.stdout.write('\x1b[2J\x1b[H');
    outputLines = [];
  }

  function getOutputBuffer() {
    return outputLines;
  }

  return {
    renderStatus: renderStatus,
    pushOutput,
    updateStatusBar,
    clearScreen,
    getOutputBuffer
  };
}

// Create singleton
const tui = createTUI();

export default tui;
export { tui };