/**
 * TINC Tools - Read, Write, Edit, Bash, Memory
 * Using only Node.js built-in modules
 * Auto-pushes to GitHub on self-edits
 */

import fs from 'fs/promises';
import { execSync } from 'child_process';

export const tools = {
  read: {
    description: 'Read file contents',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read' }
      },
      required: ['path'],
      additionalProperties: false
    },
    async execute({ path }) {
      try {
        const content = await fs.readFile(path, 'utf-8');
        return { success: true, content };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  write: {
    description: 'Create or overwrite a file',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write' },
        content: { type: 'string', description: 'Content to write' }
      },
      required: ['path', 'content'],
      additionalProperties: false
    },
    async execute({ path, content }) {
      try {
        // Anti-Flaw Protocol: Check for full overwrite risk
        let existingContent = '';
        try {
          existingContent = await fs.readFile(path, 'utf-8');
        } catch {}

        if (existingContent && existingContent.length > 0) {
          const similarity = calculateSimilarity(existingContent, content);
          if (similarity < 0.2) {
            return {
              success: false,
              error: `FULL OVERWRITE RISK: New content differs by more than 80% from existing file. Use a targeted edit instead.`,
              overwriteRisk: true,
              existingSize: existingContent.length,
              newSize: content.length,
              similarity: Math.round(similarity * 100)
            };
          }
        }

        await fs.writeFile(path, content, 'utf-8');
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  edit: {
    description: 'Patch specific lines in a file using text replacement. Auto-commits and pushes to GitHub when editing self files.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to edit' },
        oldText: { type: 'string', description: 'Text to find and replace' },
        newText: { type: 'string', description: 'Replacement text' },
        replaceAll: { type: 'boolean', description: 'Replace all occurrences', default: false }
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false
    },
    async execute({ path, oldText, newText, replaceAll = false }) {
      const selfFiles = ['boot.md', 'memory.md', 'tools.js', 'index.js', 'loop.js', 'memory.js', 'config.js', 'api.js', 'session.js'];

      try {
        const content = await fs.readFile(path, 'utf-8');
        let newContent;
        if (replaceAll) {
          newContent = content.split(oldText).join(newText);
        } else {
          if (!content.includes(oldText)) {
            return { success: false, error: 'Text not found' };
          }
          newContent = content.replace(oldText, newText);
        }
        await fs.writeFile(path, newContent, 'utf-8');

        // Auto-push to GitHub for self files
        const isSelfFile = selfFiles.some(f => path.endsWith(f));
        if (isSelfFile) {
          try {
            execSync('git add .', { stdio: 'pipe' });
            execSync(`git commit -m "Self-update: edit ${path}"`, { stdio: 'pipe' });
            execSync('git push origin master', { stdio: 'pipe' });
            return { success: true, pushed: true, message: 'Changes committed and pushed to GitHub' };
          } catch (gitError) {
            return { success: true, pushed: false, message: 'File updated but git push failed: ' + gitError.message };
          }
        }

        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  bash: {
    description: 'Execute terminal commands and return stdout/stderr',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to execute' },
        cwd: { type: 'string', description: 'Working directory (optional)' },
        timeout: { type: 'number', description: 'Timeout in ms (default: 30000)' }
      },
      required: ['command'],
      additionalProperties: false
    },
    async execute({ command, cwd = process.cwd(), timeout = 30000 }) {
      try {
        const { stdout, stderr } = await execAsync(command, { cwd, timeout });
        return { success: true, stdout, stderr };
      } catch (error) {
        return { success: false, error: error.message, stdout: error.stdout, stderr: error.stderr };
      }
    }
  },

  memory: {
    description: 'Read or append to persistent memory file',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'append'], description: 'Action to perform' },
        content: { type: 'string', description: 'Content to append (for append action)' }
      },
      required: ['action'],
      additionalProperties: false
    },
    async execute({ action, content }) {
      const MEMORY_FILE = 'memory.md';
      try {
        if (action === 'read') {
          const content = await fs.readFile('memory.md', 'utf-8');
          return { success: true, content };
        } else if (action === 'append') {
          const timestamp = new Date().toISOString();
          const entry = `\n## ${timestamp}\n${content}\n`;
          await fs.appendFile('memory.md', entry, 'utf-8');
          return { success: true };
        }
        return { success: false, error: 'Invalid action' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  github: {
    description: 'Self-update operations: clone own repo, check status, push changes',
    schema: {
      type: 'object',
      properties: {
        action: { 
          type: 'string', 
          enum: ['status', 'push', 'clone', 'verify'], 
          description: 'GitHub action to perform' 
        },
        message: { type: 'string', description: 'Commit message (for push action)' }
      },
      required: ['action'],
      additionalProperties: false
    },
    async execute({ action, message }) {
      try {
        switch (action) {
          case 'status': {
            const remote = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();
            const branch = execSync('git branch --show-current', { encoding: 'utf-8' }).trim();
            const status = execSync('git status --short', { encoding: 'utf-8' }).trim() || 'clean';
            return { success: true, remote, branch, status };
          }
          case 'push': {
            if (!message) return { success: false, error: 'Commit message required' };
            execSync('git add .', { stdio: 'pipe' });
            execSync(`git commit -m "${message}"`, { stdio: 'pipe' });
            execSync('git push origin master', { stdio: 'pipe' });
            return { success: true, message: 'Pushed to GitHub' };
          }
          case 'clone': {
            const { execSync: exec } = await import('child_process');
            exec('git clone https://github.com/mirekudev-prog/tinc-agent.git tinc-self', { stdio: 'pipe' });
            return { success: true, message: 'Cloned self to tinc-self/' };
          }
          case 'verify': {
            try {
              const remote = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();
              return { success: true, remote };
            } catch {
              return { success: false, error: 'Not a git repo or no remote' };
            }
          }
          default:
            return { success: false, error: 'Unknown action' };
        }
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  task: {
    description: 'Save/load/clear current task for self-resumption across reloads',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'load', 'clear'], description: 'Task action' },
        objective: { type: 'string', description: 'Task objective (for save)' }
      },
      required: ['action'],
      additionalProperties: false
    },
    async execute({ action, objective }) {
      try {
        if (action === 'save') {
          if (!objective) return { success: false, error: 'Objective required' };
          await fs.writeFile('current_task.json', JSON.stringify({
            objective,
            timestamp: new Date().toISOString(),
            status: 'in_progress'
          }, null, 2), 'utf-8');
          return { success: true, message: 'Task saved' };
        } else if (action === 'load') {
          const content = await fs.readFile('current_task.json', 'utf-8');
          return { success: true, task: JSON.parse(content) };
        } else if (action === 'clear') {
          await fs.unlink('current_task.json');
          return { success: true, message: 'Task cleared' };
        }
      } catch (error) {
        if (error.code === 'ENOENT' && action === 'load') {
          return { success: false, error: 'No saved task' };
        }
        return { success: false, error: error.message };
      }
    }
  }
};

// Bash needs execAsync - define here for tools.js standalone use
import { promisify } from 'util';
const execAsync = promisify(execSync);