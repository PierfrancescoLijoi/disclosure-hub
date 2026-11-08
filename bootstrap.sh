#!/bin/sh
# Disclosure Hub: set up and start on a Linux or macOS computer that has nothing installed.
# Needs no Git, no root and no system changes: if a supported Node.js release is missing it downloads the official portable Node into
# .tools/node (inside this folder), checks its SHA-256, installs the dependencies and starts the app.
# Needs only: sh, tar, and curl or wget.
#
#   sh bootstrap.sh              set up and start
#   sh bootstrap.sh --no-start   prepare everything, do not start
#   sh bootstrap.sh --stack      set up, then start the container stack (needs Docker) and print every address with user names and passwords
#   sh bootstrap.sh --demo       with the app running in another terminal: publish one announcement in each jurisdiction (UK, US, Denmark) through the API
set -eu

NODE_VERSION=22.23.4   # portable version used when the computer has no supported Node
SUPPORTED_NODE_LABEL='22.12+, 24+, or 26+'
cd "$(dirname "$0")"
ROOT=$(pwd)

step() { printf '\n==> %s\n' "$1"; }
fail() { printf '\nSetup failed: %s\nSee README.md, section "Quick start".\n' "$1" >&2; exit 1; }

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e "const [major,minor,patch]=process.versions.node.split('.').map(Number); process.exit((major===22&&(minor>12||minor===12&&patch>=0))||major===24||major>=26?0:1)"
}

fetch() { # url, output file
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -q "$1" -O "$2"
  else fail "neither curl nor wget is installed; install one of them and run this again"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else fail "no sha256sum or shasum to verify the download"
  fi
}

install_portable_node() {
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) fail "unsupported system $(uname -s); install supported Node.js ($SUPPORTED_NODE_LABEL) from https://nodejs.org" ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) fail "unsupported CPU $(uname -m); install supported Node.js ($SUPPORTED_NODE_LABEL) from https://nodejs.org" ;; esac
  if [ "$os" = linux ] && ls /lib/ld-musl-* >/dev/null 2>&1; then fail "this Linux uses musl (for example Alpine); install supported Node.js ($SUPPORTED_NODE_LABEL) with your package manager"; fi
  file="node-v$NODE_VERSION-$os-$arch.tar.gz"
  base="https://nodejs.org/dist/v$NODE_VERSION"
  mkdir -p .tools
  echo "Downloading $file from nodejs.org (about 40 MB)..."
  fetch "$base/$file" ".tools/$file"
  fetch "$base/SHASUMS256.txt" ".tools/SHASUMS256.txt"
  expected=$(grep " $file\$" .tools/SHASUMS256.txt | cut -d' ' -f1)
  actual=$(sha256_of ".tools/$file")
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then rm -f ".tools/$file"; fail "checksum mismatch for $file; download discarded"; fi
  echo "Checksum OK."
  rm -rf .tools/node
  tar -xzf ".tools/$file" -C .tools
  mv ".tools/node-v$NODE_VERSION-$os-$arch" .tools/node
  rm -f ".tools/$file" .tools/SHASUMS256.txt
}

step "1/3 Supported Node.js ($SUPPORTED_NODE_LABEL)"
[ -x .tools/node/bin/node ] && PATH="$ROOT/.tools/node/bin:$PATH"
if node_ok; then
  echo "Found Node $(node -v)"
else
  install_portable_node
  PATH="$ROOT/.tools/node/bin:$PATH"
  echo "Using the portable Node $(node -v) in .tools/node (nothing is installed system-wide)."
fi
export PATH

step "2/3 Installing the dependencies (a minute or two the first time)"
npm install --no-audit --no-fund || fail "npm install failed; read the lines above"

step "3/3 Ready"
if [ "${1:-}" = "--demo" ]; then exec npm run demo; fi
if [ "${1:-}" = "--stack" ]; then exec node scripts/stack.mjs; fi
if [ "${1:-}" = "--no-start" ]; then echo "Setup done. Start it later with: sh bootstrap.sh"; exit 0; fi
echo "Starting the light version. Open these in your browser:"
cat <<'INFO'

  http://localhost:3000
      THE APP. Pick a person on the sign-in page; there is no password in this version.
        alice  author      create, fill, validate, submit for review
        bob    secretary   approve
        carol  counsel     approve
        dan    CFO         approve
        erin   publisher   publish
      Sign out and pick the next person at each step.

Stop with Ctrl+C. For real sign-in, PostgreSQL and the mail inbox use: sh bootstrap.sh --stack
INFO
exec npm start
