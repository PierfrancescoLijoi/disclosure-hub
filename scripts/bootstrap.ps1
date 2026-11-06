# Disclosure Hub: set up and start on a Windows computer that has nothing installed.
# Needs no Git, no admin rights and no changes to the system: if Node.js 22+ is missing it downloads the official
# portable Node into .tools\node (inside this folder), checks its SHA-256, installs the dependencies and starts the app.
#
#   bootstrap.cmd              double-click it, or run it from a terminal
#   bootstrap.cmd -NoStart     prepare everything, do not start
#   bootstrap.cmd -Stack       prepare everything, then start the container stack (Docker Desktop) and print the addresses (what stack.cmd does)
#   bootstrap.cmd -Demo        with the app running in another window: publish one announcement in each jurisdiction (UK, US, Denmark) through the API
param([switch]$NoStart, [switch]$Demo, [switch]$Stack)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # progress bars make Invoke-WebRequest very slow in Windows PowerShell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$NodeVersion = '22.23.4'   # the version this was tested with; any Node 22 or newer works
$MinMajor = 22
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }

function Test-Node {
  try { $v = (& node -v) 2>$null; return [int]($v.TrimStart('v').Split('.')[0]) -ge $MinMajor } catch { return $false }
}

function Install-PortableNode {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $file = "node-v$NodeVersion-win-$arch.zip"
  $base = "https://nodejs.org/dist/v$NodeVersion"
  $tools = Join-Path $Root '.tools'
  New-Item -ItemType Directory -Force $tools | Out-Null
  $zip = Join-Path $tools $file

  Write-Host "Downloading $file from nodejs.org (about 30 MB)..."
  Invoke-WebRequest "$base/$file" -OutFile $zip -UseBasicParsing
  $sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content -split "`n"
  $expected = ($sums | Where-Object { $_ -match [regex]::Escape($file) } | Select-Object -First 1).Split(' ')[0].Trim()
  $actual = (Get-FileHash $zip -Algorithm SHA256).Hash
  if (-not $expected -or $expected -ne $actual.ToLower()) { Remove-Item $zip -Force; throw "Checksum mismatch for $file; download discarded." }
  Write-Host "Checksum OK."

  $target = Join-Path $tools 'node'
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Expand-Archive -Path $zip -DestinationPath $tools -Force
  Rename-Item (Join-Path $tools "node-v$NodeVersion-win-$arch") 'node'
  Remove-Item $zip -Force
}

try {
  Step "1/3 Node.js $MinMajor or newer"
  $local = Join-Path $Root '.tools\node'
  if (Test-Path (Join-Path $local 'node.exe')) { $env:PATH = "$local;$env:PATH" }
  if (Test-Node) {
    Write-Host ("Found Node " + (& node -v))
  } else {
    Install-PortableNode
    $env:PATH = "$local;$env:PATH"
    Write-Host ("Using the portable Node " + (& node -v) + " in .tools\node (nothing is installed system-wide).")
  }

  Step "2/3 Installing the dependencies (a minute or two the first time)"
  & npm.cmd install --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE). Read the lines above." }

  Step "3/3 Ready"
  if ($Stack) { & node (Join-Path $Root 'scripts\stack.mjs'); exit $LASTEXITCODE }
  if ($Demo) { & npm.cmd run demo; exit $LASTEXITCODE }
  if ($NoStart) { Write-Host "Setup done. Start it later with bootstrap.cmd."; exit 0 }
  Write-Host "Starting. Open http://localhost:3000 in your browser. Stop with Ctrl+C."
  & npm.cmd start
  exit $LASTEXITCODE
} catch {
  Write-Host ""
  Write-Host "Setup failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "No internet, a proxy or a blocked download are the usual causes. See README.md, section 'Quick start'."
  exit 1
}
