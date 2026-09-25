#!/usr/bin/env bash
#
# TINC Installer — clone, install, and launch TINC from GitHub
# No local files needed. First run triggers the setup wizard.
#

set -e

REPO_URL="https://github.com/mirekudev-prog/tinc-agent.git"
INSTALL_DIR="$HOME/tinc-agent"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== TINC Installer ===${NC}"
echo ""

# Check if git is available
if ! command -v git &> /dev/null; then
  echo -e "${RED}Error: git is not installed.${NC}"
  echo "Install git first: pkg install git"
  exit 1
fi

# Check if node is available
if ! command -v node &> /dev/null; then
  echo -e "${RED}Error: Node.js is not installed.${NC}"
  echo "Install Node.js: pkg install nodejs"
  exit 1
fi

# Check Node version (needs ESM support — Node 14+)
NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 14 ]; then
  echo -e "${RED}Error: Node.js v14+ required for ES modules.${NC}"
  echo "Current version: $(node --version)"
  exit 1
fi

# Check if already installed
if [ -d "$INSTALL_DIR" ]; then
  echo -e "${YELLOW}⚠️  TINC already exists at $INSTALL_DIR${NC}"
  echo ""
  read -p "Update existing installation? (y/n): " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "Updating..."
    cd "$INSTALL_DIR"
    git pull origin master
    npm install
    echo ""
    echo -e "${GREEN}✅ Updated.${NC}"
    exec node index.js run
  else
    echo "Aborted."
    exit 0
  fi
fi

# Clone the repo
echo "📦 Cloning TINC from GitHub..."
git clone "$REPO_URL" "$INSTALL_DIR" 2>&1 | sed 's/^/  /'

if [ $? -ne 0 ]; then
  echo -e "${RED}❌ Clone failed.${NC}"
  echo "Check your internet connection or try again."
  exit 1
fi

echo -e "${GREEN}✅ Cloned to $INSTALL_DIR${NC}"
echo ""

# Install dependencies
echo "📥 Installing dependencies..."
cd "$INSTALL_DIR"
npm install 2>&1 | sed 's/^/  /'

if [ $? -ne 0 ]; then
  echo -e "${RED}❌ npm install failed.${NC}"
  exit 1
fi

echo -e "${GREEN}✅ Dependencies installed.${NC}"
echo ""

# Show summary and launch
echo ""
echo -e "${BLUE}=== TINC Ready ===${NC}"
echo ""
echo "First run will trigger the setup wizard:"
echo "  1. Select your provider (groq, mistral, cerebras, nvidia)"
echo "  2. Enter your API key"
echo "  3. Select a model from the fetched list"
echo "  4. You're in the TUI loop"
echo ""
echo -e "${YELLOW}Starting TINC...${NC}"
echo ""

exec node index.js run