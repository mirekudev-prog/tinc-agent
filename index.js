#!/usr/bin/env node

/**
 * TINC - Terminal Intelligence for Nexus Coding
 * Lightweight AI coding agent for Termux
 * Self-updating: knows its own GitHub repo, can clone/edit/push itself
 */

import { program } from 'commander';
import { runLoop } from './loop.js';
import { loadBoot, appendMemory, readMemory } from './memory.js';
import { getConfig, selfPush, verifyGitSetup, selfClone } from './config.js';

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
    await runLoop(options.provider, options.model, boot);
  });

program
  .command('reload')
  .description('Reload boot.md and memory.md, restart loop')
  .action(async () => {
    console.log('Reloading configuration...');
    const boot = await loadBoot();
    const memory = await readMemory();
    console.log('Configuration reloaded. Restarting loop...');
    process.env.TINC_RELOAD = '1';
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
    console.log(`  API Keys configured: ${Object.keys(config.apiKeys).filter(k => config.apiKeys[k]).join(', ') || 'none'}`);
    console.log('');
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
      console.log(`  Status: ${status.status}`);
    }
  });

program
  .command('git-push <message>')
  .description('Commit and push changes to GitHub')
  .action(async (message) => {
    const success = await selfPush(message);
    process.exit(success ? 0 : 1);
  });

program
  .command('self-clone')
  .description('Clone own GitHub repo to tinc-self/ directory')
  .action(async () => {
    const success = await selfClone();
    process.exit(success ? 0 : 1);
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
      console.log(content);
    } else if (options.append) {
      await appendMemory(options.append);
      console.log('Appended to memory.md');
    }
  });

program.parse();