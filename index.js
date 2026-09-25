#!/usr/bin/env node
/**
 * TINC - Terminal Intelligence for Nexus Coding
 * Lightweight AI coding agent for Termux
 * 
 * TUI: Lightweight Terminal User Interface (NO alternate screen buffer)
 * Raw ANSI escape codes only - Termux native touch scrolling works
 */

import { program } from 'commander';
import { runLoop } from './loop.js';
import { loadBoot, appendMemory, readMemory } from './memory.js';
import { getConfig, selfPush, verifyGitSetup, selfClone } from './config.js';
import tui, { updateTUIStatus } from './tui.js';

let currentStatus = {
  model: '',
  provider: '',
  tokens: 0,
  task: 'idle',
  thinking: false
};

function syncStatus(status) {
  currentStatus = { ...currentStatus, ...status };
  tui.updateStatusBar(currentStatus);
}

program
  .name('tinc')
  .description('TINC - Lightweight AI coding agent for Termux')
  .version('0.1.0');

program
  .command('run')
  .description('Start the TINC agent loop')
  .option('-p, --provider <provider>', 'LLM provider (groq, mistral, cerebras, nvidia)', 'groq')
  .option('-m, --model <model>', 'Model name (leave empty to use configured)')
  .action(async (options) => {
    const boot = await loadBoot();
    
    // Clear screen and show TUI
    tui.clearScreen();
    tui.updateStatusBar({
      model: options.model || 'not set',
      provider: options.provider,
      tokens: 0,
      task: 'starting',
      thinking: false
    });
    
    // Small delay so status renders first
    await new Promise(r => setTimeout(r, 50));
    
    tui.pushOutput('🔧 TINC started. Type /help for commands.\n');
    syncStatus({ task: 'running' });
    
    await runLoop(options.provider, options.model, boot);
  });

program
  .command('reload')
  .description('Reload boot.md and memory.md, restart loop')
  .action(async () => {
    tui.pushOutput('🔄 Reloading configuration...\n');
    syncStatus({ task: 'reloading', thinking: true });
    
    await new Promise(r => setTimeout(r, 100));
    
    const boot = await loadBoot();
    const memory = await readMemory();
    
    tui.pushOutput('Configuration reloaded. Restarting loop...\n');
    syncStatus({ task: 'running', thinking: false });
    
    process.env.TINC_RELOAD = '1';
    await runLoop('', '', '');
  });

program
  .command('config')
  .description('Show current configuration')
  .action(async () => {
    const config = await getConfig();
    tui.clearScreen();
    tui.pushOutput('\n📋 Current Configuration:\n');
    tui.pushOutput(`  Provider: ${config.provider}\n`);
    tui.pushOutput(`  Model: ${config.model || '(not set)'}\n`);
    tui.pushOutput(`  Repo: ${config.repoUrl}\n`);
    tui.pushOutput(`  Branch: ${config.branch}\n`);
    tui.pushOutput(`  API Keys configured: ${Object.keys(config.apiKeys).filter(k => config.apiKeys[k]).join(', ') || 'none'}\n`);
    tui.pushOutput('\n');
  });

program
  .command('git-status')
  .description('Check git repository status')
  .action(async () => {
    const status = await verifyGitSetup();
    if (status) {
      tui.pushOutput('\n📋 Git Status:\n');
      tui.pushOutput(`  Remote: ${status.remoteUrl}\n`);
      tui.pushOutput(`  Branch: ${status.ranch}\n`);
      tui.pushOutput(`  Status: ${status.status}\n`);
    }
  });

program
  .command('git-push <message>')
  .description('Commit and push changes to GitHub')
  .action(async (message) => {
    tui.pushOutput(`📤 Pushing: ${message}\n`);
    const success = await selfPush(message);
    tui.pushOutput(success ? '✅ Pushed to GitHub\n' : '❌ Git push failed\n');
  });

program
  .command('self-clone')
  .description('Clone own GitHub repo to tinc-self/ directory')
  .action(async () => {
    tui.pushOutput('📦 Cloning self from GitHub...\n');
    const success = await selfClone();
    tui.pushOutput(success ? '✅ Clone complete\n' : '❌ Clone failed\n');
  });

program
  .command('memory')
  .description('Manage memory')
  .option('-r, --read', 'Read memory.md')
  .option('-a, --append <text>', 'Append to memory.md')
  .action(async (options) => {
    if (options.read) {
      const fs = await import('fs/promises');
      const content = await fs.readFile('memory.md', 'utf-8');
      tui.pushOutput(content);
    } else if (options.append) {
      await appendMemory(options.append);
      tui.pushOutput('Appended to memory.md\n');
    }
  });

program.parse();

// Export status updater for use in loop.js
export { syncStatus };