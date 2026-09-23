# bushwhack-tray.ps1 -- bushwhack in the Windows notification area: whether the service
# runs, the projects and the chats they are live in, and the few things a click is enough
# for: a terminal in a project, its app, the pairing code.
#
# A view, not a supervisor: the service starts with the first bushwhack command and keeps
# running when the tray quits. Everything goes through the CLI (`bushwhack list --json`),
# in background processes a timer collects, so the menu never waits on the service.
#
# Started hidden by bushwhack-tray.vbs (the Start menu shortcut, and "Start with
# Windows"), or by bushwhack-tray.cmd from a terminal.
#
# Keep this file ASCII-only: Windows PowerShell 5.1 (powershell.exe) reads a BOM-less
# file in the system code page, and a stray accent can break the parse before the icon
# shows.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

. (Join-Path $PSScriptRoot 'bushwhack-tray-look.ps1')

# One tray per session: a second start (the shortcut, clicked twice) leaves quietly.
$createdNew = $false
$singleton = New-Object System.Threading.Mutex($true, 'Local\bushwhack-tray-singleton', [ref]$createdNew)
if (-not $createdNew) { $singleton.Dispose(); exit 0 }
# setup.ps1 sets this to have the tray quit cleanly before it starts the new one.
$quitSignal = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::ManualReset, 'Local\bushwhack-tray-quit')
$quitSignal.Reset() | Out-Null

$root = Split-Path -Parent $PSScriptRoot
$command = Join-Path $root 'bin\bushwhack.cmd'
$cli = Join-Path $root 'packages\daemon\src\cli.ts'
$tsx = 'file:///' + ((Join-Path $root 'node_modules\tsx\dist\esm\index.mjs') -replace '\\', '/')
$icons = Join-Path $root 'extension\icons'
$stateDir = if ($env:XDG_STATE_HOME) { Join-Path $env:XDG_STATE_HOME 'bushwhack' } else { Join-Path $env:USERPROFILE '.local\state\bushwhack' }
$serviceFile = Join-Path $stateDir 'service\service.json'

# --- commands, run without blocking the message loop -------------------------------
function Start-Command([string]$file, [string[]]$arguments) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $file
    # Quoted one by one: a folder may hold spaces.
    $psi.Arguments = ($arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    # node writes UTF-8; PowerShell would read the console's code page.
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $psi.CreateNoWindow = $true
    try {
        $p = [System.Diagnostics.Process]::Start($psi)
        return @{ process = $p; out = $p.StandardOutput.ReadToEndAsync(); err = $p.StandardError.ReadToEndAsync() }
    } catch {
        return @{ process = $null; failed = $_.Exception.Message }
    }
}
# The CLI itself, through node: a .cmd would need a shell, and a console would flash.
function Start-Bushwhack([string[]]$arguments) { return Start-Command 'node' (@('--conditions=bushwhack-src', '--import', $tsx, $cli) + $arguments) }

# $null while it runs; then @{ code; out; err }.
function Receive-Command($c) {
    if (-not $c) { return $null }
    if (-not $c.process) { return @{ code = -1; out = ''; err = $c.failed } }
    if (-not $c.process.HasExited -or -not $c.out.IsCompleted -or -not $c.err.IsCompleted) { return $null }
    $r = @{ code = $c.process.ExitCode; out = $c.out.Result; err = $c.err.Result }
    $c.process.Dispose()
    return $r
}

# Whether the service answers, as itself: its port from service.json, its /health naming it.
function Test-Service {
    try {
        $file = Get-Content -Raw $serviceFile | ConvertFrom-Json
        if (-not $file.port) { return $false }
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($file.port)/health" -TimeoutSec 1 -ErrorAction Stop
        return ($health.daemon -eq $file.id)
    } catch { return $false }
}

function Open-Url([string]$u) {
    # Through the shell: the link opens in the default browser, in its running profile.
    if ($u) { Start-Process -FilePath 'explorer.exe' -ArgumentList $u }
}

# A terminal in a folder, running bushwhack there: Windows Terminal when it is installed.
function Open-Terminal([string]$folder, [string]$what) {
    $wt = Get-Command wt.exe -ErrorAction SilentlyContinue
    if ($wt) {
        Start-Process -FilePath $wt.Source -ArgumentList @('-d', "`"$folder`"", 'cmd', '/k', "`"$command`" $what")
    } else {
        Start-Process -FilePath 'cmd.exe' -WorkingDirectory $folder -ArgumentList @('/k', "`"$command`" $what")
    }
}

# --- autostart: a Run value, the one Settings > Apps > Startup shows and can turn off --
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'bushwhack-tray'
function Test-Autostart {
    try { return [bool](Get-ItemProperty -Path $runKey -Name $runName -ErrorAction Stop).$runName } catch { return $false }
}
function Set-Autostart([bool]$on) {
    if ($on) {
        $vbs = Join-Path $PSScriptRoot 'bushwhack-tray.vbs'
        Set-ItemProperty -Path $runKey -Name $runName -Value "wscript.exe `"$vbs`"" -Type String
    } else {
        Remove-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue
    }
}

# --- the icon -------------------------------------------------------------------------
function Get-Icon([string]$name) {
    $path = Join-Path $icons "$name.ico"
    if (Test-Path $path) { try { return New-Object System.Drawing.Icon $path } catch { } }
    return [System.Drawing.SystemIcons]::Application
}
$upIcon = Get-Icon 'tray'
$downIcon = Get-Icon 'tray-down'

$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = $downIcon
$ni.Text = 'bushwhack - looking...'
$ni.Visible = $true

# What the last look found: the menu is built from it when it opens.
$script:look = $null
$script:list = $null

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$ni.ContextMenuStrip = $menu

# $tag: what the handler acts on, read back as $this.Tag -- a closure would not see this
# script's functions.
function Add-Item($items, [string]$text, [scriptblock]$onClick, $tag = $null) {
    $item = New-Object System.Windows.Forms.ToolStripMenuItem
    $item.Text = $text
    $item.Tag = $tag
    if ($onClick) { $item.Add_Click($onClick) } else { $item.Enabled = $false }
    $items.Add($item) | Out-Null
    return $item
}

function Build-Menu {
    $menu.Items.Clear()
    $line = if ($script:look) { $script:look.line } else { 'Looking...' }
    Add-Item $menu.Items $line $null | Out-Null
    $menu.Items.Add('-') | Out-Null

    if ($script:look -and $script:look.up) {
        foreach ($p in @($script:list.projects | Where-Object { $_ })) {
            $item = Add-Item $menu.Items (Get-ProjectLabel $p) { }
            Add-Item $item.DropDownItems 'Open a terminal here (bushwhack)' { Open-Terminal $this.Tag '' } ([string]$p.folder) | Out-Null
            if ($p.url) { Add-Item $item.DropDownItems "Open its app ($($p.url))" { Open-Url $this.Tag } ([string]$p.url) | Out-Null }
            Add-Item $item.DropDownItems 'Open the folder' { Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$($this.Tag)`"" } ([string]$p.folder) | Out-Null
        }
        if (@($script:list.projects | Where-Object { $_ }).Count -eq 0) {
            Add-Item $menu.Items 'No project yet: bushwhack, in a project folder' $null | Out-Null
        }
        $menu.Items.Add('-') | Out-Null
        Add-Item $menu.Items "Copy the pairing code ($($script:list.code))" { [System.Windows.Forms.Clipboard]::SetText([string]$this.Tag) } ([string]$script:list.code) | Out-Null
        Add-Item $menu.Items 'Open an approvals terminal' { Open-Terminal $env:USERPROFILE 'approvals' } | Out-Null
    } elseif ($script:look) {
        Add-Item $menu.Items 'Start the service' { $script:starting = Start-Bushwhack @('list'); $ni.ShowBalloonTip(3000, 'bushwhack', 'Starting the service...', [System.Windows.Forms.ToolTipIcon]::None) } | Out-Null
    }
    $menu.Items.Add('-') | Out-Null
    $auto = Add-Item $menu.Items 'Start with Windows' { Set-Autostart (-not (Test-Autostart)) }
    $auto.Checked = Test-Autostart
    Add-Item $menu.Items 'bushwhack on GitHub' { Open-Url $this.Tag } 'https://github.com/quazardous/bushwhack-cli' | Out-Null
    $menu.Items.Add('-') | Out-Null
    Add-Item $menu.Items 'Quit (the service keeps running)' { Exit-Tray } | Out-Null
}
$menu.Add_Opening({ Build-Menu })

# Quitting takes the icon away: a tray killed instead leaves a dead one in the notification
# area until the mouse passes over it.
function Exit-Tray {
    $script:quitting = $true
    $ni.Visible = $false
    [System.Windows.Forms.Application]::Exit()
}

# A left click opens the same menu: the projects are what one clicks the adventurer for.
$ni.Add_MouseUp({
    param($sender, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        $show = [System.Windows.Forms.NotifyIcon].GetMethod('ShowContextMenu', [System.Reflection.BindingFlags]'Instance,NonPublic')
        $show.Invoke($ni, $null) | Out-Null
    }
})

# --- looking --------------------------------------------------------------------------
$script:probe = $null
$script:starting = $null
$script:quitting = $false
function Start-Look {
    if ($script:probe) { return }
    # A stopped service is not started by looking at it: only "Start the service" does.
    if (-not (Test-Service)) { Show-Look $null; return }
    $script:probe = Start-Bushwhack @('list', '--json')
}
function Receive-Look {
    $r = Receive-Command $script:probe
    if (-not $r) { return }
    $script:probe = $null
    $list = $null
    if ($r.code -eq 0) { try { $list = $r.out | ConvertFrom-Json } catch { } }
    Show-Look $list
}
function Show-Look($list) {
    $before = $script:look
    $script:list = $list
    $script:look = Get-TrayLook $list
    $ni.Icon = if ($script:look.up) { $upIcon } else { $downIcon }
    $ni.Text = $script:look.tooltip
    $news = Get-TrayNews $before $script:look
    if ($news) { $ni.ShowBalloonTip(5000, 'bushwhack', $news, [System.Windows.Forms.ToolTipIcon]::Info) }
}

$script:ticks = 0
function Update-Tray {
    if ($script:quitting) { return }
    if ($quitSignal.WaitOne(0)) { Exit-Tray; return }
    if ($script:starting) {
        $s = Receive-Command $script:starting
        if ($s) { $script:starting = $null; $script:ticks = 0 }
    }
    Receive-Look
    # A look every 5 seconds; the timer ticks every second to collect answers quickly.
    if ($script:ticks % 5 -eq 0) { Start-Look }
    $script:ticks++
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({ Update-Tray })
$timer.Start()
Update-Tray

try {
    [System.Windows.Forms.Application]::Run()
} finally {
    $timer.Stop()
    $ni.Visible = $false
    $ni.Dispose()
    try { $singleton.ReleaseMutex() } catch { }
    $singleton.Dispose()
}
