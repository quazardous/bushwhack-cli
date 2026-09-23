# bushwhack-tray-look.ps1 -- what the tray shows for what bushwhack says, as pure
# functions the tray dot-sources and a test runs under pwsh (no WinForms).
#
# Keep this file ASCII-only, like bushwhack-tray.ps1: Windows PowerShell 5.1 reads a
# BOM-less file in the system code page.

# $list: what `bushwhack list --json` printed, or $null when the service does not answer.
function Get-TrayLook($list) {
    if (-not $list) {
        return @{ up = $false; line = 'The bushwhack service is not running'; tooltip = 'bushwhack - service stopped' }
    }
    $projects = @($list.projects | Where-Object { $_ })
    $live = @($projects | Where-Object { $_.chat })
    $browsers = @($list.browsers | Where-Object { $_ })
    $count = if ($projects.Count -eq 1) { '1 project' } else { "$($projects.Count) projects" }
    $chats = if ($live.Count -eq 0) { 'no chat open' } elseif ($live.Count -eq 1) { '1 chat live' } else { "$($live.Count) chats live" }
    $browser = if ($browsers.Count -eq 0) { ', no browser paired' } else { '' }
    $mode = if ($list.mode -eq 'octopod') { ' (octopod)' } else { '' }
    return @{
        up = $true
        line = "$count - $chats$browser$mode"
        tooltip = (Get-TrayTooltip "bushwhack - $count, $chats$browser")
    }
}

# NotifyIcon.Text is capped at 63 characters.
function Get-TrayTooltip([string]$text) {
    if ($text.Length -le 63) { return $text }
    return $text.Substring(0, 60) + '...'
}

# A project's menu entry: its name, and the chat it is live in.
function Get-ProjectLabel($project) {
    if ($project.chat) {
        $where = if ($project.chat.chat) { $project.chat.chat } else { 'a web chat' }
        return "$($project.session) - live in $where"
    }
    return "$($project.session) - no chat open"
}

# What changed between two looks that is worth a balloon: a chat opened or closed, the
# service stopped or back. $null when nothing.
function Get-TrayNews($before, $after) {
    if (-not $before) { return $null }
    if ($before.up -and -not $after.up) { return 'The bushwhack service stopped' }
    if (-not $before.up -and $after.up) { return 'The bushwhack service is back' }
    return $null
}

# The Mode submenu: the two modes, the current one checked; octopod only when it is there
# to run the apps. $current: 'standalone' or 'octopod' (what `bushwhack mode` wrote).
function Get-ModeChoices([string]$current, [bool]$octopodFound) {
    $octopodLabel = if ($octopodFound) { 'octopod - the app in its containers' } else { 'octopod - not installed (npm i -g @quazardous/octopod)' }
    return @(
        @{ mode = 'standalone'; label = "Standalone - the project's files, nothing run"; checked = ($current -eq 'standalone'); enabled = ($current -ne 'standalone') }
        @{ mode = 'octopod'; label = $octopodLabel; checked = ($current -ne 'standalone'); enabled = ($current -eq 'standalone' -and $octopodFound) }
    )
}

# What to ask before switching: the service restarts, and what that cuts.
function Get-ModeQuestion([string]$mode) {
    $what = if ($mode -eq 'standalone') { "each project's files served as they are, nothing run - no app:* tools" } else { 'the app in its containers, through octopod and Docker' }
    return "Switch bushwhack to $mode mode ($what)?`r`n`r`nThe service restarts: the chats reconnect by themselves, and a call running now is cut (the chat can send it again). Give each chat the tools manifest again: the tools change."
}
