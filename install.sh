#!/usr/bin/env bash
#
# TINC Installer — install TINC as a global command
# Type `tinc` anywhere after install to launch it.
#

set -e

REPO_URL="https://github.com/mirekudev-prog/tinc-agent.git"
INSTALL_DIR="$HOME/tinc-agent"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=== TINC Installer ===${NC}"
echo ""

# Check prerequisites
if ! command -v git &> /dev/null; then
  echo -e "${RED}Error: git is not installed.${NC}"
  echo "Install: pkg install git"
  exit 1
fi

if ! command -v node &> /dev/null; then
  echo -e "${RED}Error: Node.js is not installed.${NC}"
  echo "Install: pkg install nodejs"
  exit 1
fi

NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo -e "${RED}Error: Node.js v18+ required.${NC}"
  echo "Current: $(node --version)"
  exit 1
fi

# Already installed?
if [ -d "$INSTALL_DIR" ]; then
  echo -e "${YELLOW}⚠️  TINC already exists at $INSTALL_DIR${NC}"
  echo ""
  read -p "Update and reinstall? (y/n): " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    cd "$INSTALL_DIR"
    git pull origin master
  else
    echo "Aborted."
    exit 0
  fi
fi

# Clone fresh if not present
if [ ! -d "$INSTALL_DIR" ]; then
  echo "📦 Cloning TINC from GitHub..."
  git clone "$REPO_URL" "$INSTALL_DIR" 2>&1 | sed 's/^/  /'
  if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Clone failed.${NC}"
    exit 1
  fi
  echo -e "${GREEN}✅ Cloned to $INSTALL_DIR${NC}"
fi

# Install globally
echo ""
echo "📥 Installing TINC globally..."
cd "$INSTALL_DIR"
npm install -g . 2>&1 | sed 's/^/  /'

if [ $? -ne 0 ]; then
  echo -e "${RED}❌ Global install failed.${NC}"
  echo ""
  echo "Try running locally instead:"
  echo "  cd $INSTALL_DIR && node index.js run"
  exit 1
fi

echo -e "${GREEN}✅ TINC installed globally.${NC}"
echo ""

# Verify binary is on PATH
if command -v tinc &> /dev/null; then
  echo -e "${GREEN}✅ 'tinc' command is ready.${NC}"
else
  echo -e "${YELLOW}⚠️  'tinc' not found on PATH.${NC}"
  echo "The binary is at: $(which tinc 2>/dev/null || echo '$INSTALL_DIR/index.js')"
  echo "Add to PATH or run: node $INSTALL_DIR/index.js run"
fi

echo ""
echo -e "${BLUE}=== TINC Ready ===${NC}"
echo ""
echo "Launch anytime by typing:"
echo "  tinc"
echo ""
echo "First run triggers the setup wizard:"
echo "  1. Select provider (groq, mistral, cerebras, nvidia)"
echo "  2. Enter API key"
echo "  3. Select model"
echo "  4. You're in the TUI loop"
echo ""

read -p "Launch TINC now? (y/n): " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
  exec tinc
fi

echo "Run 'tinc' anytime to start."
