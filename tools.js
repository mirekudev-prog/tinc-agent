/**
 * TINC Tools - Read, Write, Edit, Bash, Memory
 * Using only Node.js built-in modules
 */

import fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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
        await fs.writeFile(path, content, 'utf-8');
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  edit: {
    description: 'Patch specific lines in a file using regex or line numbers. Automatically commits and pushes changes to git when editing config files.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to edit' },
        oldText: { type: 'string', description: 'Text to find and replace' },
        newText: { type: 'string', description: 'Replacement text' },
        replaceAll: { type: 'boolean', description: 'Replace all occurrences', default: false },
        autoPush: { type: 'boolean', description: 'Auto commit and push to git (default: true for config files)', default: true }
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false
    },
    async execute({ path, oldText, newText, replaceAll = false, autoPush = true }) {
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
        
        // Auto-push for config files
        const configFiles = ['boot.md', 'memory.md', 'tools.js', 'index.js', 'loop.js', 'memory.js', 'tools.js'];
        const isConfigFile = configFiles.some(f => path.includes(f) || path.endsWith(f));
        
        if (autoPush && isConfigFile) {
          try {
            await execAsync('git add .', { cwd: process.cwd() });
            await execAsync('git commit -m "Self-update: ' + path + '"', { cwd: process.cwd() });
            await execAsync('git push origin main', { cwd: process.cwd() });
            return { success: true, autoPushed: true };
          } catch (gitError) {
            return { success: true, autoPushed: false, gitError: gitError.message };
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
  }
};