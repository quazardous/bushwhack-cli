# bushwhack's Windows installer, in one line:
#
#   irm https://raw.githubusercontent.com/quazardous/bushwhack-cli/main/install.ps1 | iex
#
# It needs no admin and no Git. Node.js 22 or later is used when there is one; otherwise a
# portable Node LTS is put in bushwhack's folder. The code goes in
# %LOCALAPPDATA%\bushwhack\app; setup.ps1 then installs the dependencies, builds the
# extension, puts `bushwhack` on your PATH and starts the tray. Run it again to update.
#
# Standalone by default: no Docker, no octopod. Before running it, to choose otherwise:
#   $env:BUSHWHACK_SETUP_ARGS = '-UseOctopod'   # or '-NoTray'
#   $env:BUSHWHACK_REF = 'some-branch'          # another branch or tag than main
#   $env:BUSHWHACK_DIR = 'D:\tools\bushwhack'    # another folder
#
# Keep this file ASCII-only: Windows PowerShell 5.1 reads a BOM-less file in the system
# code page. It runs in the caller's own session (iex): it never calls exit, which would
# close their window, and runs setup.ps1 in a process of its own.

& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest's progress bar slows downloads tenfold in 5.1
    # Windows PowerShell 5.1 may offer only TLS 1.0 by default; GitHub and nodejs.org need 1.2.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $repo = 'quazardous/bushwhack-cli'
    $ref = if ($env:BUSHWHACK_REF) { $env:BUSHWHACK_REF } else { 'main' }
    $home_ = if ($env:BUSHWHACK_DIR) { $env:BUSHWHACK_DIR } else { Join-Path $env:LOCALAPPDATA 'bushwhack' }
    $app = Join-Path $home_ 'app'
    $binDir = Join-Path $HOME '.local\bin'
    $setupArgs = if ($env:BUSHWHACK_SETUP_ARGS) { @($env:BUSHWHACK_SETUP_ARGS -split '\s+' | Where-Object { $_ }) } else { @() }

    function Say($m) { Write-Host $m -ForegroundColor White }
    function Fail($m) { throw "bushwhack install: $m" }

    # The user's PATH, for good (new terminals) and for this session (setup.ps1, now).
    function Add-ToPath([string]$dir) {
        $user = [Environment]::GetEnvironmentVariable('Path', 'User')
        $parts = @($user -split ';' | Where-Object { $_ })
        if (-not ($parts | Where-Object { $_.TrimEnd('\') -ieq $dir.TrimEnd('\') })) {
            [Environment]::SetEnvironmentVariable('Path', (@($dir) + $parts) -join ';', 'User')
            Write-Host "  added to your PATH: $dir"
        }
        if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $dir.TrimEnd('\') })) { $env:Path = "$dir;$env:Path" }
    }

    function Get-NodeMajor {
        $node = Get-Command node -ErrorAction SilentlyContinue
        if (-not $node) { return 0 }
        try { return [int](& $node.Source -p "process.versions.node.split('.')[0]") } catch { return 0 }
    }

    Say 'Node.js'
    if ((Get-NodeMajor) -ge 22) {
        Write-Host "  $(node -v), already there"
    } else {
        # The latest LTS of 22 or later, as a zip: no installer, no admin, nothing outside our folder.
        $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
        $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
        $pick = $index | Where-Object { $_.lts -and [int]($_.version.TrimStart('v').Split('.')[0]) -ge 22 -and $_.files -contains "win-$arch-zip" } | Select-Object -First 1
        if (-not $pick) { Fail "no Node.js LTS for win-$arch on nodejs.org" }
        $name = "node-$($pick.version)-win-$arch"
        $nodeDir = Join-Path $home_ "node\$name"
        if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) {
            Write-Host "  downloading Node.js $($pick.version) ($arch)..."
            $zip = Join-Path $env:TEMP "$name.zip"
            Invoke-WebRequest "https://nodejs.org/dist/$($pick.version)/$name.zip" -OutFile $zip -UseBasicParsing
            New-Item -ItemType Directory -Force (Join-Path $home_ 'node') | Out-Null
            Expand-Archive $zip -DestinationPath (Join-Path $home_ 'node') -Force
            Remove-Item $zip -Force
        }
        Add-ToPath $nodeDir
        Write-Host "  $(& (Join-Path $nodeDir 'node.exe') -v), in $nodeDir"
    }

    Say "bushwhack ($ref)"
    $work = Join-Path $env:TEMP "bushwhack-install-$PID"
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force $work | Out-Null
    $zip = Join-Path $work 'source.zip'
    Write-Host "  downloading github.com/$repo, $ref..."
    Invoke-WebRequest "https://github.com/$repo/archive/$ref.zip" -OutFile $zip -UseBasicParsing
    Expand-Archive $zip -DestinationPath $work -Force
    $source = Get-ChildItem $work -Directory | Select-Object -First 1
    if (-not $source -or -not (Test-Path (Join-Path $source.FullName 'setup.ps1'))) { Fail "the archive of $ref holds no setup.ps1" }

    if (Test-Path $app) {
        # An update: what runs from the old copy lets go of it first. The tray is asked to quit
        # (killed, it would leave a dead icon); the service stops, and the first bushwhack
        # command after starts it again from the new copy.
        try {
            $quit = [System.Threading.EventWaitHandle]::OpenExisting('Local\bushwhack-tray-quit')
            $quit.Set() | Out-Null
            $quit.Dispose()
        } catch { }
        Start-Sleep -Seconds 2
        $state = if ($env:XDG_STATE_HOME) { Join-Path $env:XDG_STATE_HOME 'bushwhack' } else { Join-Path $HOME '.local\state\bushwhack' }
        foreach ($file in Get-ChildItem $state -Filter service.json -Recurse -ErrorAction SilentlyContinue) {
            try {
                $s = Get-Content -Raw $file.FullName | ConvertFrom-Json
                $health = Invoke-RestMethod "http://127.0.0.1:$($s.port)/health" -TimeoutSec 1
                if ($health.daemon -eq $s.id -and $s.pid) { Stop-Process -Id $s.pid -Force -ErrorAction SilentlyContinue; Write-Host '  stopped the running service' }
            } catch { }
        }
        # An Explorer window on a folder in it holds it too: the one this script opened on
        # extension\dist last time, often still there.
        try {
            $appUrl = 'file:///' + ($app -replace '\\', '/')
            foreach ($w in @((New-Object -ComObject Shell.Application).Windows())) {
                if ($w.LocationURL -and $w.LocationURL.StartsWith($appUrl, [StringComparison]::OrdinalIgnoreCase)) { $w.Quit() }
            }
        } catch { }
        # A process killed lets go of its files a moment later.
        $old = "$app.old-$(Get-Date -Format yyyyMMddHHmmss)"
        for ($try = 1; $true; $try++) {
            try { Rename-Item $app $old; break }
            catch {
                if ($try -ge 10) { Fail "$app is in use (a terminal or a program in it?): close it, and run this again" }
                Start-Sleep -Seconds 1
            }
        }
        Remove-Item $old -Recurse -Force -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Force $home_ | Out-Null
    Move-Item $source.FullName $app
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  in $app"

    Add-ToPath $binDir

    # setup.ps1 ends with exit on a failure: in a process of its own, not in this window.
    Say 'setup.ps1'
    $ps = (Get-Process -Id $PID).Path
    & $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $app 'setup.ps1') @setupArgs
    if ($LASTEXITCODE -ne 0) { Fail "setup.ps1 failed (exit $LASTEXITCODE): its messages are above" }

    # The one step left is Chrome's: an unpacked extension is loaded by hand, once.
    $dist = Join-Path $app 'extension\dist'
    Write-Host ''
    Say 'Last step, once: the extension'
    Write-Host '  In Chrome: chrome://extensions -> Developer mode (top right) -> Load unpacked ->'
    Write-Host "  $dist"
    $chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($chrome) { Start-Process $chrome 'chrome://extensions' }
    Start-Process explorer.exe "`"$dist`""
    Write-Host '  (opened for you: the extensions page, and the folder to pick)'
    Write-Host ''
    Write-Host '  Then, in a project folder (a new terminal: the PATH changed):  bushwhack'
}
