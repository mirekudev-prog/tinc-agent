# TINC — Terminal Intelligence for Nexus Coding

A lightweight, Termux-native AI coding agent that runs directly in your terminal. No VS Code. No alternate screen buffer. No heavy UI libraries.

Built for mobile developers, vibe coders, and anyone who wants an AI agent in their terminal without the bloat.

## What Makes TINC Different

- **Termux-first**: Designed to run on Android Termux from day one
- **No alternate screen buffer**: Native touch scrolling works in Termux — the TUI doesn't hijack your terminal
- **Raw ANSI TUI**: Three-zone interface (status bar, output stream, input prompt) using only escape codes — zero dependencies
- **Self-aware**: TINC knows its own GitHub repo. It can clone itself, edit its own code, commit, and push back
- **Anti-Flaw Protocol**: Built-in protection against the most common AI agent failures — lost state, silent errors, destructive file edits, resource leaks, encoding corruption

## Features

- **Setup Wizard** — First run walks you through provider selection, API key entry, and model selection (auto-fetches from provider API)
- **Multi-provider** — Groq, Mistral, Cerebras, NVIDIA NIM (all OpenAI-compatible endpoints)
- **Smart Retries** — 10-attempt exponential backoff (2s → 240s) on 429/500 errors
- **Context Compaction** — Proactive summarization at 70% context usage with strict 4:1 char-to-token ratio
- **Session Resumption** — Pick up exactly where you left off with `/resume`
- **Slash Commands** — `/reload`, `/model`, `/provider`, `/help`, `/bottom`, `/exit`
- **Self-Update** — `edit` tool auto-commits and pushes when modifying TINC's own files
- **Git Tools** — `git-status`, `git-push`, `self-clone` commands built in
- **Task Persistence** — `current_task.json` saves your objective across reloads

## Quick Start

### Install from GitHub

```bash
git clone https://github.com/mirekudev-prog/tinc-agent.git
cd tinc-agent
npm install
node index.js run
```

Or use the install script (Termux):
```bash
curl -sL https://raw.githubusercontent.com/mirekudev-prog/tinc-agent/main/install.sh | bash
```

### First Run

TINC will launch the setup wizard:
1. Select your provider (groq, mistral, cerebras, nvidia)
2. Enter your API key
3. Select a model from the auto-fetched list
4. You're in the TUI loop

### Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/reload` | Reload config without restarting |
| `/model <name>` | Change model or `/model list` to fetch available |
| `/provider <name>` | Switch provider |
| `/resume` | Load last session state |
| `/bottom` | Jump to bottom of output |
| `/exit` | Quit (cleans up child processes) |

## TUI Layout

```
┌─────────────────────────────────────────────────────┐
│ TINC | [THINKING] Model: llama-3.1-70b │ Provider:  │  ← Status Bar (1 line)
│ groq │ tokens: 12843 │ fixing login bug             │
├─────────────────────────────────────────────────────┤
│                                                      │
│  [LLM output streams here...]                       │  ← Output Stream
│  Tool results, reasoning, file contents...          │     (native touch scroll)
│                                                      │
│                                                      │
│  > /help                                            │  ← Input Prompt (always at bottom)
└─────────────────────────────────────────────────────┘
```

## Anti-Flaw Protocol

TINC enforces these rules automatically:

1. **State is Sacred** — `session_state.json` and `current_task.json` saved after every tool call
2. **No Silent Failures** — Errors are logged with full details, never swallowed
3. **Safe File Edits** — Targeted patches only. Full overwrite (>80% diff) is blocked and requires explicit confirmation
4. **Clean Exits** — SIGINT/SIGTERM kill all spawned child processes
5. **UTF-8 Enforced** — All file I/O explicitly uses UTF-8
6. **Loud Errors** — Failed API calls print exact HTTP status + error message after retries exhausted

## Self-Update Workflow

TINC can modify its own code and push changes to GitHub:

1. TINC uses the `edit` tool to patch a file
2. If it's a self-file (boot.md, tools.js, loop.js, etc.), it auto-commits and pushes
3. The `task` tool saves the current objective to `current_task.json`
4. On next boot, TINC checks for `current_task.json` and resumes the task

This creates a self-improving loop — TINC can update itself and continue where it left off.

## Project Structure

```
tinc-agent/
├── index.js       # CLI entry point (commander)
├── loop.js        # Main agent loop + TUI integration
├── tools.js       # Read/Write/Edit/Bash/Memory/GitHub/Task tools
├── config.js      # Setup wizard, provider config, self-push
├── api.js         # LLM call wrapper with retries + chunking
├── session.js     # Session state + task persistence
├── tui.js         # Lightweight Termux TUI (raw ANSI)
├── memory.js      # Boot/memory file loader
├── boot.md        # Persona + Anti-Flaw Protocol rules
├── install.sh     # One-line install script
└── package.json   # ESM + commander dependency
```

## Providers

TINC works with any OpenAI-compatible API. Built-in support for:

| Provider | API Base URL |
|----------|-------------|
| Groq | `https://api.groq.com/openai/v1` |
| Mistral | `https://api.mistral.ai/v1` |
| Cerebras | `https://api.cerebras.ai/v1` |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` |

## Hardware

Tested on:
- Termux on Android (ARM)
- Node.js v18+
- Git + npm

## License

MIT

## Author

mirekudev-prog

---

**TINC** = Terminal Intelligence for Nexus Coding