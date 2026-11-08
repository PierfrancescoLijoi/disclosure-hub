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

function Get-Sha256([string]$Path) {
  # Use .NET directly: Get-FileHash is not available in every Windows PowerShell session.
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $stream.Dispose()
    $sha.Dispose()
  }
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
  $sumLine = $sums | Where-Object { $_ -match "\s$([regex]::Escape($file))`$" } | Select-Object -First 1
  if (-not $sumLine) { Remove-Item $zip -Force; throw "No checksum published for $file; download discarded." }
  $expected = ($sumLine -split '\s+')[0].ToLowerInvariant()
  $actual = Get-Sha256 $zip
  if ($expected -ne $actual) { Remove-Item $zip -Force; throw "Checksum mismatch for $file; download discarded." }
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
  Write-Host "Starting the light version. Open these in your browser:"
  Write-Host @"

  http://localhost:3000
      THE APP. Pick a person on the sign-in page; there is no password in this version.
        alice  author      create, fill, validate, submit for review
        bob    secretary   approve
        carol  counsel     approve
        dan    CFO         approve
        erin   publisher   publish
      Sign out and pick the next person at each step.

Stop with Ctrl+C. For real sign-in, PostgreSQL and the mail inbox use: stack.cmd
"@
  & npm.cmd start
  exit $LASTEXITCODE
} catch {
  Write-Host ""
  Write-Host "Setup failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "No internet, a proxy or a blocked download are the usual causes. See README.md, section 'Quick start'."
  exit 1
}
