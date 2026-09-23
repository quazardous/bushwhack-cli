<#
Sets bushwhack up from a clone on Windows: dependencies, the extension, and the `bushwhack`
command on your PATH. Safe to run again (after a pull, for instance). Needs no admin.

  .\setup.ps1                        # puts the command in ~\.local\bin; standalone by default:
                                     # no Docker, no octopod - the chat's app is the project's
                                     # files served as they are, nothing run
  .\setup.ps1 -Dev                   # the same, for development: no production extension build
  .\setup.ps1 -UseOctopod            # the app in its containers instead, through octopod
                                     # (Docker Desktop): a dev server, databases
  .\setup.ps1 -NoTray                # ... without the tray icon and its Start menu shortcut
  $env:BIN_DIR="$HOME\bin"; .\setup.ps1   # ... or elsewhere

The command runs the sources: a change to the code needs no new setup, only a restart of
what runs it. Run it again after a dependency change. The mode (standalone or octopod) is
kept across runs: `bushwhack mode` says it and changes it.
#>
param(
  [switch]$Dev,
  [switch]$Standalone,
  [switch]$UseOctopod,
  [switch]$NoTray,
  [switch]$Help
)
$ErrorActionPreference = 'Stop'

if ($Help) { Get-Help $PSCommandPath -Full | Out-String | Write-Host; exit 0 }

$Root = $PSScriptRoot
$BinDir = if ($env:BIN_DIR) { $env:BIN_DIR } else { Join-Path $HOME '.local\bin' }

function Say($m) { Write-Host $m -ForegroundColor White }
function Warn($m) { Write-Host "! $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "x $m" -ForegroundColor Red; exit 1 }

Say 'Checking requirements'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js is not installed (22 or later is needed)' }
$major = [int](node -p 'process.versions.node.split(".")[0]')
if ($major -lt 22) { Fail "Node.js $(node -v) is too old: 22 or later is needed" }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'npm is not installed' }
Write-Host "  node $(node -v)"

Say 'Installing dependencies'
Push-Location $Root
try {
  npm install --no-fund --no-audit
  if ($LASTEXITCODE -ne 0) { Fail 'npm install failed' }

  if ($Dev) {
    Say 'Extension: development build'
    Write-Host '  not built here: npm run ext:watch builds extension/dist-dev on every change and reloads it'
  } else {
    Say 'Building the extension'
    npm run --silent ext:build
    if ($LASTEXITCODE -ne 0) { Fail 'the extension build failed' }
    Write-Host "  built into $Root\extension\dist"
  }
} finally { Pop-Location }

Say 'Installing the bushwhack command'
New-Item -ItemType Directory -Force $BinDir | Out-Null
$marker = 'bushwhack shim for'
$cmdShim = Join-Path $BinDir 'bushwhack.cmd'
$shShim = Join-Path $BinDir 'bushwhack'
foreach ($target in $cmdShim, $shShim) {
  if ((Test-Path $target) -and -not ((Get-Content $target -Raw) -match [regex]::Escape("$marker $Root"))) {
    if (-not ((Get-Content $target -Raw) -match [regex]::Escape($marker))) {
      Fail "$target exists and is not a bushwhack; move it away, or set BIN_DIR to another folder"
    }
  }
}
# PowerShell and cmd: calls bin\bushwhack.cmd of this clone.
Set-Content -Path $cmdShim -Encoding ascii -Value @(
  '@echo off'
  "rem $marker $Root"
  "call `"$Root\bin\bushwhack.cmd`" %*"
)
# Git Bash: bin/bushwhack builds a file:// URL from a /c/... path, which node cannot load.
$rootSlash = $Root -replace '\\', '/'
[IO.File]::WriteAllText($shShim, @"
#!/bin/sh
# $marker $Root
ROOT='$rootSlash'
exec node --conditions=bushwhack-src --import "file:///`$ROOT/node_modules/tsx/dist/esm/index.mjs" "`$ROOT/packages/daemon/src/cli.ts" "`$@"

"@)
Write-Host "  $cmdShim -> $Root\bin\bushwhack.cmd"
Write-Host "  $shShim (Git Bash)"
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$onPath = ($env:Path -split ';') + ($userPath -split ';') | Where-Object { $_ -and ($_.TrimEnd('\') -ieq $BinDir.TrimEnd('\')) }
if (-not $onPath) {
  Warn "$BinDir is not on your PATH: add it with"
  Write-Host "    [Environment]::SetEnvironmentVariable('Path', `"$BinDir;`" + [Environment]::GetEnvironmentVariable('Path','User'), 'User')"
  Write-Host '  then open a new terminal'
}

$bushwhack = Join-Path $Root 'bin\bushwhack.cmd'
# Standalone unless octopod is asked for; a mode chosen before is kept across runs.
if ($Standalone) { & $bushwhack mode standalone | Out-Null }
if ($UseOctopod) { & $bushwhack mode octopod | Out-Null }
# `bushwhack mode` says "standalone: ..." or "octopod: ...": its first word, without the colon.
$mode = ((& $bushwhack mode) -split '\s+' | Where-Object { $_ })[0].TrimEnd(':')

if ($mode -eq 'standalone') {
  Say 'Web app: standalone'
  Write-Host "  the chat's app is the project's files served as they are, at http://<project>.localhost:<port>/:"
  Write-Host '  HTML, CSS and JavaScript in the browser, nothing run on this machine - no Docker, no octopod'
  Write-Host '  (for an app in containers, with a dev server and databases: .\setup.ps1 -UseOctopod)'
} else {
  Say 'Web app tools (optional)'
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Warn 'Docker is not installed: octopod mode needs it (.\setup.ps1 -Standalone: the project's files served as a site instead)'
  } elseif (-not $(docker compose version 2>$null | Out-Null; $LASTEXITCODE -eq 0)) {
    Warn 'Docker Compose v2 (docker compose) is missing: the app tools need it'
  } elseif (-not $(docker info 2>$null | Out-Null; $LASTEXITCODE -eq 0)) {
    Warn 'Docker does not answer: start Docker Desktop, then run this again (the app tools need it)'
  } elseif ($env:BUSHWHACK_OCTOPOD -or (Get-Command octopod -ErrorAction SilentlyContinue)) {
    $octopod = if ($env:BUSHWHACK_OCTOPOD) { $env:BUSHWHACK_OCTOPOD } else { (Get-Command octopod).Source }
    # The contract bushwhack speaks (OCTOPOD_CONTRACT in packages/daemon/src/octopod-client.ts).
    $said = try { & $octopod version --json 2>$null | Out-String } catch { '' }
    $v = try { $said | ConvertFrom-Json } catch { $null }
    if (-not $v -or -not $v.contract) {
      Warn "octopod at $octopod does not answer ``octopod version`` (older than 0.1, or a broken install): npm i -g @quazardous/octopod - the app tools stay off until then"
    } elseif ("$($v.contract)" -eq '1') {
      Write-Host "  octopod: $octopod ($($v.version), contract 1)"
      # Contract 1 since 0.1, but Windows works from 0.3: docker compose was not found before.
      $mm = "$($v.version)" -split '[.-]'
      if ([int]$mm[0] -eq 0 -and [int]$mm[1] -lt 3) {
        Warn "octopod $($v.version) predates its Windows fixes (0.3): update it (npm i -g @quazardous/octopod, or git pull and .\setup.ps1 in its clone)"
      }
    } else {
      Warn "octopod at $octopod speaks contract $($v.contract), this bushwhack contract 1: update the older of the two"
    }
  } else {
    Warn 'octopod is not on your PATH (nor BUSHWHACK_OCTOPOD set): the app tools stay off until it is'
    Write-Host '  to install it:  npm i -g @quazardous/octopod; octopod setup   (0.3 or later; not `octopod` alone: another project on npm)'
    Write-Host '  or from a clone, with its tray in the Start menu:  git clone https://github.com/quazardous/octopod, then .\setup.ps1 in it'
  }
}

if (-not $NoTray) {
  Say 'The tray icon'
  $vbs = Join-Path $Root 'bin\bushwhack-tray.vbs'
  $shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'bushwhack.lnk'
  $link = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
  $link.TargetPath = 'wscript.exe'
  $link.Arguments = "`"$vbs`""
  $link.IconLocation = Join-Path $Root 'extension\icons\tray.ico'
  $link.Description = 'bushwhack: the service, the projects and their chats'
  $link.Save()
  Write-Host "  Start menu: $shortcut"
  # A tray already running is the one of before this setup: started again, it runs this code.
  # Asked to quit, it takes its icon away; killed, it would leave a dead one in the
  # notification area. Killed only when it does not quit.
  $old = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object { $_.CommandLine -match 'bushwhack-tray\.ps1' })
  if ($old.Count -gt 0) {
    try {
      $quit = [System.Threading.EventWaitHandle]::OpenExisting('Local\bushwhack-tray-quit')
      $quit.Set() | Out-Null
      $quit.Dispose()
    } catch { }
    foreach ($p in $old) {
      try { Wait-Process -Id $p.ProcessId -Timeout 5 -ErrorAction Stop } catch { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    }
  }
  Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$vbs`""
  Write-Host '  started: the adventurer in the notification area (right-click it; "Start with Windows" is there)'
}

if ($Dev) {
  $extensionStep = @"
1. Keep npm run ext:watch running, and start the browser with npm run chromium:
     it loads extension/dist-dev. Do not load extension/dist in the same browser too -
     two bushwhack extensions would both act on the chat pages.
"@
} else {
  $extensionStep = @"
1. Load the extension once: chrome://extensions -> Developer mode -> Load unpacked ->
     $Root\extension\dist
     (after a later .\setup.ps1, press its reload button there)
"@
}

Write-Host ''
Say 'Done. Next:'
Write-Host @"
  $extensionStep
  2. In each folder a chat should work on:  bushwhack add
     (the first bushwhack command starts the service, in the background)
  3. In a terminal you keep open:  bushwhack approvals   (writes wait for your yes there)
  4. On a meta.ai, Gemini or ChatGPT conversation, open the bushwhack panel: pair once with
     the code bushwhack list shows, then "Use for this chat" and "Insert the tools manifest".

  More: $Root\docs\guide.md
"@
