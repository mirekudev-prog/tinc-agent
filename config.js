/**
 * TINC Config - Global configuration and setup wizard
 * Auto-fetches available models from provider APIs
 * Knows its own GitHub repo for self-update
 */

import fs from 'fs/promises';
import { execSync } from 'child_process';

const CONFIG_FILE = 'tinc_config.json';

const DEFAULT_CONFIG = {
  provider: 'groq',
  model: '',
  apiKeys: {
    groq: '',
    mistral: '',
    cerebras: '',
    nvidia: ''
  },
  sessionFile: 'session_state.json',
  repoUrl: 'https://github.com/mirekudev-prog/tinc-agent.git',
  branch: 'master'
};

// Provider configurations with model fetch endpoints
const PROVIDERS = {
  groq: {
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    modelsEndpoint: '/models',
    apiKeyEnv: 'GROQ_API_KEY'
  },
  mistral: {
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    modelsEndpoint: '/models',
    apiKeyEnv: 'MISTRAL_API_KEY'
  },
  cerebras: {
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    modelsEndpoint: '/models',
    apiKeyEnv: 'CEREBRAS_API_KEY'
  },
  nvidia: {
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    modelsEndpoint: '/models',
    apiKeyEnv: 'NVIDIA_API_KEY'
  }
};

export async function loadConfig() {
  try {
    const content = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function saveConfig(config) {
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

export async function getConfig() {
  const config = await loadConfig();
  if (!config) {
    return await runSetupWizard();
  }
  return config;
}

export async function updateProvider() {
  const config = await loadConfig();
  const providers = Object.keys(PROVIDERS);
  
  console.log('\nAvailable providers:');
  providers.forEach((p, i) => console.log(`  ${i + 1}. ${PROVIDERS[p].name}`));
  
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  const ask = (question) => new Promise(resolve => rl.question(question, resolve));
  
  const providerChoice = await ask('\nSelect provider (1-' + providers.length + '): ');
  const provider = providers[parseInt(providerChoice) - 1];
  
  if (!provider) return;
  
  const apiKey = await ask(`Enter API key for ${PROVIDERS[provider].name}: `);
  
  // Fetch models
  console.log(`\nFetching models from ${PROVIDERS[provider].name}...`);
  const models = await fetchModels(provider, apiKey);
  
  let model = '';
  if (models.length > 0) {
    console.log('\nAvailable models:');
    models.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
    const modelChoice = await ask('\nSelect model (number): ');
    const modelIndex = parseInt(modelChoice) - 1;
    if (models[modelIndex]) {
      model = models[modelIndex];
    }
  } else {
    model = await ask('Enter model ID manually: ');
  }
  
  config.provider = provider;
  config.model = model;
  config.apiKeys[provider] = apiKey;
  await saveConfig(config);
  
  console.log(`\n✅ Updated: provider=${provider}, model=${model}`);
  process.exit(0);
}

export async function updateModel() {
  const config = await loadConfig();
  const providerConfig = PROVIDERS[config.provider];
  
  if (!providerConfig) {
    console.log('Unknown provider');
    return;
  }
  
  if (!config.apiKeys[config.provider]) {
    console.log('No API key configured for current provider');
    return;
  }
  
  console.log(`\nFetching models from ${providerConfig.name}...`);
  const models = await fetchModels(config.provider, config.apiKeys[config.provider]);
  
  if (models.length === 0) {
    console.log('Could not fetch models. Enter manually:');
    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise(r => rl.question(q, r));
    const model = await ask('Enter model ID: ');
    rl.close();
    config.model = model;
    await saveConfig(config);
    return;
  }
  
  console.log('\nAvailable models:');
  models.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
  
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(r => rl.question(q, r));
  const choice = await ask('\nSelect model (number): ');
  rl.close();
  
  const idx = parseInt(choice) - 1;
  if (models[idx]) {
    config.model = models[idx];
    await saveConfig(config);
    console.log(`\n✅ Model set to: ${config.model}`);
  }
}

async function fetchModels(provider, apiKey) {
  const providerConfig = PROVIDERS[provider];
  if (!providerConfig) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  try {
    const response = await fetch(`${providerConfig.baseUrl}${providerConfig.modelsEndpoint}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    if (data.data && Array.isArray(data.data)) {
      return data.data.map(m => m.id).filter(id => id && typeof id === 'string');
    }
    if (Array.isArray(data)) {
      return data.map(m => m.id || m).filter(id => id && typeof id === 'string');
    }
    return [];
  } catch (error) {
    console.warn(`Failed to fetch models for ${provider}:`, error.message);
    return [];
  }
}

// ---------- SETUP WIZARD ----------
async function runSetupWizard() {
  console.log('\n=== TINC Setup Wizard ===\n');
  console.log('Welcome to TINC! Let\'s configure your environment.\n');

  const providers = Object.keys(PROVIDERS);
  
  console.log('Available providers:');
  providers.forEach((p, i) => console.log(`  ${i + 1}. ${PROVIDERS[p].name}`));
  
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const ask = (question) => new Promise(resolve => rl.question(question, resolve));

  // Select provider
  const providerChoice = await ask('\nSelect provider (1-' + providers.length + '): ');
  const provider = providers[parseInt(providerChoice) - 1] || 'groq';
  const providerConfig = PROVIDERS[provider];

  // Get API key
  const apiKey = await ask(`Enter API key for ${providerConfig.name}: `);

  // Fetch available models
  console.log(`\nFetching available models from ${providerConfig.name}...`);
  const models = await fetchModels(provider, apiKey);
  
  let model = '';
  if (models.length > 0) {
    console.log('\nAvailable models:');
    models.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
    
    const modelChoice = await ask('\nSelect model (number): ');
    const modelIndex = parseInt(modelChoice) - 1;
    if (models[modelIndex]) {
      model = models[modelIndex];
    }
  } else {
    console.log('\nCould not fetch models. Enter model ID manually:');
    model = await ask('Enter model ID: ');
  }

  // Confirm GitHub repo
  console.log('\nGitHub self-update configuration:');
  console.log(`  Repo URL: ${DEFAULT_CONFIG.repoUrl}`);
  console.log(`  Branch: ${DEFAULT_CONFIG.branch}`);
  const confirm = await ask('Accept these settings? (Y/n): ');
  if (confirm.toLowerCase() === 'n') {
    const repoUrl = await ask('Enter your GitHub repo URL: ');
    DEFAULT_CONFIG.repoUrl = repoUrl;
  }

  const config = {
    ...DEFAULT_CONFIG,
    provider,
    model,
    apiKeys: {
      ...DEFAULT_CONFIG.apiKeys,
      [provider]: apiKey
    }
  };

  await saveConfig(config);
  rl.close();
  
  console.log('\n✅ Configuration saved to tinc_config.json\n');
  return config;
}

// ---------- GITHUB SELF-UPDATE ----------
export async function selfPush(commitMessage) {
  try {
    // Save current task if not already saved
    const taskPath = 'current_task.json';
    try {
      const taskContent = await fs.readFile(taskPath, 'utf-8');
      const task = JSON.parse(taskContent);
      if (!task.committed) {
        task.committed = true;
        await fs.writeFile(taskPath, JSON.stringify(task, null, 2), 'utf-8');
      }
    } catch {}

    // Git operations
    execSync('git add .', { stdio: 'inherit' });
    execSync(`git commit -m "${commitMessage}"`, { stdio: 'inherit' });
    execSync('git push origin master', { stdio: 'inherit' });
    
    console.log('\n✅ Pushed to GitHub successfully\n');
    return true;
  } catch (error) {
    console.error('\n❌ Git push failed:', error.message, '\n');
    return false;
  }
}

export async function selfClone() {
  const config = await loadConfig();
  const repoUrl = config.repoUrl || DEFAULT_CONFIG.repoUrl;
  
  console.log(`\n📦 Cloning self from ${repoUrl}...`);
  try {
    const { execSync } = await import('child_process');
    execSync(`git clone ${repoUrl} tinc-self-updated`, { stdio: 'inherit' });
    console.log('✅ Clone complete\n');
    return true;
  } catch (error) {
    console.error('❌ Clone failed:', error.message, '\n');
    return false;
  }
}

export function getRepoInfo() {
  return {
    url: DEFAULT_CONFIG.repoUrl,
    branch: DEFAULT_CONFIG.branch,
    localPath: process.cwd(),
    remote: 'origin'
  };
}

// Verify git setup
export async function verifyGitSetup() {
  try {
    // Check if directory is a git repo
    const { execSync } = await import('child_process');
    const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();
    const branch = execSync('git branch --show-current', { encoding: 'utf-8' }).trim();
    
    console.log('\n📋 Git setup verified:');
    console.log(`  Remote: ${remoteUrl}`);
    console.log(`  Branch: ${branch}`);
    console.log(`  Status: ${execSync('git status --short', { encoding: 'utf-8' }).trim() || 'clean'}\n`);
    
    return { remoteUrl, branch };
  } catch (error) {
    console.log('\n⚠️  Not a git repository or no remote configured\n');
    return null;
  }
}