#!/bin/sh
# Disclosure Hub: set up and start on a Linux or macOS computer that has nothing installed.
# Needs no Git, no root and no system changes: if Node.js 22+ is missing it downloads the official portable Node into
# .tools/node (inside this folder), checks its SHA-256, installs the dependencies and starts the app.
# Needs only: sh, tar, and curl or wget.
#
#   sh bootstrap.sh              set up and start
#   sh bootstrap.sh --no-start   prepare everything, do not start
#   sh bootstrap.sh --demo       with the app running in another terminal: publish one UK and one US announcement through the API
set -eu

NODE_VERSION=22.23.4   # the version this was tested with; any Node 22 or newer works
MIN_MAJOR=22
cd "$(dirname "$0")"
ROOT=$(pwd)

step() { printf '\n==> %s\n' "$1"; }
fail() { printf '\nSetup failed: %s\nSee README.md, section "Quick start".\n' "$1" >&2; exit 1; }

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  major=$(node -v | sed 's/^v//; s/\..*//')
  [ "$major" -ge "$MIN_MAJOR" ] 2>/dev/null
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
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) fail "unsupported system $(uname -s); install Node.js 22+ from https://nodejs.org" ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) fail "unsupported CPU $(uname -m); install Node.js 22+ from https://nodejs.org" ;; esac
  if [ "$os" = linux ] && ls /lib/ld-musl-* >/dev/null 2>&1; then fail "this Linux uses musl (for example Alpine); install Node.js 22+ with your package manager"; fi
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

step "1/3 Node.js $MIN_MAJOR or newer"
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
if [ "${1:-}" = "--no-start" ]; then echo "Setup done. Start it later with: sh bootstrap.sh"; exit 0; fi
echo "Starting. Open http://localhost:3000 in your browser. Stop with Ctrl+C."
exec npm start
