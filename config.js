/**
 * TINC Config - Global configuration, setup wizard, key vault
 * Config lives in ~/.tinc (outside the repo) — survives reinstalls, never committed.
 * API keys XOR-obfuscated at rest (no plaintext on disk).
 */

import fs from 'fs/promises';
import { createHash, randomBytes } from 'crypto';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(os.homedir(), '.tinc');
const CONFIG_FILE = path.join(DATA_DIR, 'tinc_config.json');
const KEY_FILE = path.join(DATA_DIR, '.keymaterial');

export const DEFAULT_CONFIG = {
  provider: 'groq',
  model: '',
  apiKeys: {},
  customProviders: {},
  repoUrl: 'https://github.com/mirekudev-prog/tinc-agent.git',
  branch: 'master'
};

export const PROVIDERS = {
  groq: {
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    keyUrl: 'https://console.groq.com/keys'
  },
  mistral: {
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    keyUrl: 'https://console.mistral.ai/'
  },
  cerebras: {
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    keyUrl: 'https://cloud.cerebras.ai/'
  },
  nvidia: {
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKeyEnv: 'NVIDIA_API_KEY',
    keyUrl: 'https://build.nvidia.com/'
  },
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    keyUrl: 'https://openrouter.ai/keys'
  }
};

// ---------- KEY OBFUSCATION ----------
// Simple XOR with per-install random key material — keeps plaintext keys
// out of config files while staying dependency-free.

async function getKeyMaterial() {
  try {
    const km = await fs.readFile(KEY_FILE);
    return km;
  } catch {
    const km = randomBytes(32);
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(KEY_FILE, km, { mode: 0o600 });
    return km;
  }
}

function xorBuffer(buf, keyMaterial) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ keyMaterial[i % keyMaterial.length];
  }
  return out;
}

async function obfuscateKey(plain) {
  const km = await getKeyMaterial();
  return 'enc:' + xorBuffer(Buffer.from(plain, 'utf-8'), km).toString('base64');
}

async function deobfuscateKey(stored) {
  if (typeof stored !== 'string' || !stored.startsWith('enc:')) return stored;
  try {
    const km = await getKeyMaterial();
    return xorBuffer(Buffer.from(stored.slice(4), 'base64'), km).toString('utf-8');
  } catch {
    return '';
  }
}

// ---------- CONFIG LOAD/SAVE ----------

async function loadConfigRaw() {
  try {
    const content = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function saveConfig(config) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  // Never write plaintext keys to disk
  const toSave = { ...config };
  if (toSave.apiKeys) {
    const sealed = {};
    for (const [prov, key] of Object.entries(toSave.apiKeys)) {
      sealed[prov] = key ? await obfuscateKey(key) : '';
    }
    toSave.apiKeys = sealed;
  }
  await fs.writeFile(CONFIG_FILE, JSON.stringify(toSave, null, 2), 'utf-8');
}

export async function loadConfig() {
  const config = await loadConfigRaw();
  if (!config) return null;
  if (config.apiKeys) {
    const opened = {};
    for (const [prov, key] of Object.entries(config.apiKeys)) {
      opened[prov] = await deobfuscateKey(key);
    }
    config.apiKeys = opened;
  }
  return { ...DEFAULT_CONFIG, ...config };
}

export async function getConfig(ask) {
  const config = await loadConfig();
  if (!config) {
    if (typeof ask !== 'function') {
      console.log('No configuration found. Run "tinc run" to start the setup wizard.');
      process.exit(1);
    }
    return await runSetupWizard(ask);
  }
  return config;
}

// ---------- MODEL FETCHING ----------

export async function fetchModels(provider, apiKey, customProviders = {}) {
  let baseUrl;
  if (provider.startsWith('custom:')) {
    const cp = customProviders[provider.slice(7)];
    baseUrl = cp ? cp.baseUrl : null;
  } else {
    baseUrl = PROVIDERS[provider]?.baseUrl;
  }
  if (!baseUrl) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: controller.signal
    });
    if (!response.ok) return [];
    const data = await response.json();
    if (Array.isArray(data?.data)) {
      return data.data.map(m => m.id).filter(id => id && typeof id === 'string');
    }
    if (Array.isArray(data)) {
      return data.map(m => m.id || m).filter(id => id && typeof id === 'string');
    }
    return [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ---------- SETUP WIZARD ----------

export async function runSetupWizard(askFn) {
  const ask = askFn || (async (q) => {
    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => rl.question(q, resolve));
    rl.close();
    return answer;
  });

  console.log('\n=== TINC Setup Wizard ===');
  console.log('First run — configure your AI provider.\n');

  const providerNames = Object.keys(PROVIDERS);
  console.log('Available providers:');
  providerNames.forEach((p, i) => console.log(`  ${i + 1}. ${PROVIDERS[p].name} (free tier available)`));
  console.log(`  ${providerNames.length + 1}. Custom OpenAI-compatible endpoint\n`);

  const providerChoice = (await ask('Select provider (1-' + (providerNames.length + 1) + '): ')).trim();
  const idx = parseInt(providerChoice) - 1;

  let provider = 'groq';
  let customProviders = {};

  if (idx >= 0 && idx < providerNames.length) {
    provider = providerNames[idx];
  } else if (idx === providerNames.length) {
    provider = 'custom';
    let name = (await ask('Name this provider (e.g. myapi): ')).trim().toLowerCase() || 'myapi';
    name = name.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'myapi';
    const baseUrl = (await ask('Base URL (e.g. https://api.example.com/v1): ')).trim().replace(/\/+$/, '');
    if (!baseUrl) {
      console.log('Base URL required — aborting setup.');
      process.exit(1);
    }
    customProviders[name] = { name, baseUrl };
    provider = 'custom:' + name;
  } else {
    provider = 'groq';
  }

  const providerConfig = PROVIDERS[provider] || { name: provider, keyUrl: '' };
  console.log(`\nGet an API key: ${providerConfig.keyUrl || '(your provider\'s dashboard)'}`);

  let apiKey = (await ask(`Enter API key for ${providerConfig.name}: `)).trim();
  // Fall back to env var if user hits enter
  if (!apiKey) {
    const envName = provider.startsWith('custom:') ? 'CUSTOM_API_KEY' : (PROVIDERS[provider]?.apiKeyEnv || '');
    apiKey = process.env[envName] || '';
    if (apiKey) console.log(`(using ${envName} from environment)`);
  }

  console.log(`\nFetching models...`);
  const models = await fetchModels(provider, apiKey, customProviders);

  let model = '';
  if (models.length > 0) {
    console.log('\nAvailable models:');
    models.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
    const modelChoice = (await ask('\nSelect model (number): ')).trim();
    const modelIndex = parseInt(modelChoice) - 1;
    model = models[modelIndex] || models[0];
  } else {
    console.log('(could not fetch models — enter model ID manually)');
    model = (await ask('Enter model ID: ')).trim();
  }

  const config = {
    ...DEFAULT_CONFIG,
    provider,
    model,
    customProviders,
    apiKeys: { [provider]: apiKey }
  };

  await saveConfig(config);
  console.log(`\n✅ Config saved to ~/.tinc/tinc_config.json (keys obfuscated)`);
  console.log(`   Provider: ${provider}, Model: ${model}\n`);
  return config;
}

// ---------- PROMPT SANITIZATION (from OWURA) ----------

const REDACT_PATTERNS = [
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, 'EMAIL'],
  [/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, 'PHONE'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, 'IP'],
  [/sk-[a-zA-Z0-9]{20,}/g, 'API_KEY'],
  [/ghp_[a-zA-Z0-9]{36}/g, 'API_KEY'],
  [/gsk_[a-zA-Z0-9]{20,}/g, 'API_KEY'],
  [/password\s*[=:]\s*["'][^"']+["']/gi, 'PASSWORD'],
  [/secret\s*[=:]\s*["'][^"']+["']/gi, 'SECRET']
];

export function sanitizePrompt(text) {
  let sanitized = text;
  let redacted = 0;
  for (const [pattern, label] of REDACT_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      redacted += matches.length;
      sanitized = sanitized.replace(pattern, `[REDACTED_${label}]`);
    }
  }
  return { sanitized, redacted };
}

// ---------- GITHUB SELF-UPDATE ----------

export async function selfPush(commitMessage) {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);
  try {
    await execAsync('git add .');
    await execAsync(`git commit -m "${commitMessage}"`);
    await execAsync('git push origin master');
    console.log('\n✅ Pushed to GitHub');
    return true;
  } catch (error) {
    console.error('\n❌ Git push failed:', error.message);
    return false;
  }
}

export async function selfClone() {
  const config = await loadConfig();
  const repoUrl = config?.repoUrl || DEFAULT_CONFIG.repoUrl;
  console.log(`\n📦 Cloning self from ${repoUrl}...`);
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);
  try {
    await execAsync(`git clone ${repoUrl} tinc-self`);
    console.log('✅ Clone complete\n');
    return true;
  } catch (error) {
    console.error('❌ Clone failed:', error.message);
    return false;
  }
}

export async function verifyGitSetup() {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);
  try {
    const { stdout: remoteUrl } = await execAsync('git remote get-url origin');
    const { stdout: branch } = await execAsync('git branch --show-current');
    const { stdout: status } = await execAsync('git status --short');
    return {
      remoteUrl: remoteUrl.trim(),
      branch: branch.trim(),
      status: status.trim() || 'clean'
    };
  } catch (error) {
    console.log('\n⚠️  Not a git repository or no remote configured\n');
    return null;
  }
}
