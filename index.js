#!/usr/bin/env node

/**
 * TINC - Terminal Intelligence for Nexus Coding
 * Lightweight AI coding agent for Termux
 */

import { program } from 'commander';
import { runLoop } from './loop.js';
import { loadBoot, appendMemory, readMemory } from './memory.js';

program
  .name('tinc')
  .description('TINC - Lightweight AI coding agent for Termux')
  .version('0.1.0');

program
  .command('run')
  .description('Start the TINC agent loop')
  .option('-p, --provider <provider>', 'LLM provider (groq, mistral, cerebras)', 'groq')
  .option('-m, --model <model>', 'Model name', 'llama-3.1-70b-versatile')
  .action(async (options) => {
    const boot = await loadBoot();
    await runLoop(options.provider, options.model, boot);
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

program
  .command('reload')
  .description('Reload boot.md and memory.md, restart loop')
  .action(async () => {
    console.log('Reloading configuration...');
    const boot = await loadBoot();
    const memory = await readMemory();
    console.log('Configuration reloaded. Restarting loop...');
    // In a real implementation, this would restart the loop
    console.log('Boot length:', boot.length, 'chars');
    console.log('Memory length:', memory.length, 'chars');
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