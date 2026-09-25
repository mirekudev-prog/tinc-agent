#!/usr/bin/env node
/**
 * TINC - Terminal Intelligence for Nexus Coding
 * Lightweight AI coding agent for Termux.
 *
 * TUI: no alternate screen buffer — raw ANSI only, native touch scrolling works.
 */

import { program } from 'commander';
import { runLoop } from './loop.js';
import { loadBoot, appendMemory, readMemory } from './memory.js';
import { getConfig, selfPush, verifyGitSetup, selfClone } from './config.js';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const DATA_DIR = path.join(os.homedir(), '.tinc');

program
  .name('tinc')
  .description('TINC - Lightweight AI coding agent for Termux')
  .version('0.2.0');

program
  .command('run')
  .description('Start the TINC agent loop')
  .option('-p, --provider <provider>', 'LLM provider (groq, mistral, cerebras, nvidia, openrouter, custom:<name>)', '')
  .option('-m, --model <model>', 'Model name (leave empty to use configured)')
  .action(async (options) => {
    await runLoop(options.provider, options.model, '');
  });

program
  .command('reload')
  .description('Reload boot.md and memory.md, restart loop')
  .action(async () => {
    console.log('🔄 Reloading configuration...');
    await runLoop('', '', '');
  });

program
  .command('config')
  .description('Show current configuration')
  .action(async () => {
    const config = await getConfig();
    console.log('\n📋 Current Configuration:');
    console.log(`  Provider: ${config.provider}`);
    console.log(`  Model: ${config.model || '(not set)'}`);
    console.log(`  Repo: ${config.repoUrl}`);
    console.log(`  Branch: ${config.branch}`);
    const keys = Object.keys(config.apiKeys || {}).filter(k => config.apiKeys[k]);
    console.log(`  API Keys configured: ${keys.join(', ') || 'none'}`);
    console.log(`  Config file: ${path.join(DATA_DIR, 'tinc_config.json')}\n`);
  });

program
  .command('git-status')
  .description('Check git repository status')
  .action(async () => {
    const status = await verifyGitSetup();
    if (status) {
      console.log('\n📋 Git Status:');
      console.log(`  Remote: ${status.remoteUrl}`);
      console.log(`  Branch: ${status.branch}`);
      console.log(`  Status: ${status.status}\n`);
    }
  });

program
  .command('git-push <message>')
  .description('Commit and push changes to GitHub')
  .action(async (message) => {
    console.log(`📤 Pushing: ${message}`);
    const ok = await selfPush(message);
    console.log(ok ? '✅ Pushed to GitHub' : '❌ Git push failed');
  });

program
  .command('self-clone')
  .description('Clone own GitHub repo to tinc-self/ directory')
  .action(async () => {
    console.log('📦 Cloning self from GitHub...');
    const ok = await selfClone();
    console.log(ok ? '✅ Clone complete' : '❌ Clone failed');
  });

program
  .command('memory')
  .description('Manage memory')
  .option('-r, --read', 'Read memory.md')
  .option('-a, --append <text>', 'Append to memory.md')
  .action(async (options) => {
    if (options.read) {
      const content = await readMemory();
      console.log(content || '(memory empty)');
    } else if (options.append) {
      await appendMemory(options.append);
      console.log('Appended to ~/.tinc/memory.md');
    } else {
      console.log('Usage: tinc memory --read | tinc memory --append "text"');
    }
  });

program.parse();
