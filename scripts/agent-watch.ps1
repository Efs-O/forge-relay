param(
    [Parameter(Mandatory = $true)]
    [string]$Agent,

    [ValidateSet("check", "watch")]
    [string]$Mode = "check",

    [int]$IntervalSeconds = 3
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path $PSScriptRoot -Parent
$CoordDir = Join-Path $RepoRoot ".coordination"
$CommandsPath = Join-Path $RepoRoot ".coordination\commands.json"
$EventsPath = Join-Path $RepoRoot ".coordination\events.ndjson"
$AgentStateDir = Join-Path $CoordDir "state"
$LastReadPath = Join-Path $AgentStateDir ("{0}-last-read.txt" -f $Agent.ToLowerInvariant())

function Read-Commands {
    if (-not (Test-Path -LiteralPath $CommandsPath)) {
        return @()
    }

    $raw = Get-Content -LiteralPath $CommandsPath -Raw
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return @()
    }

    $state = $raw | ConvertFrom-Json
    return @($state.commands)
}

function Get-BlockingCommands {
    param(
        [string]$AgentName
    )

    $commands = Read-Commands
    $blockingCommands = @($commands | Where-Object {
        ($_.status -eq "open" -or $_.status -eq "acknowledged") -and
        ($_.target_agent -eq "all" -or $_.target_agent -eq $AgentName) -and
        ($_.text -match '(?i)\bSTOP\b' -or $_.text -match '(?i)\bPAUSE\b')
    })
    return $blockingCommands
}

function Initialize-AgentStateDir {
    if (-not (Test-Path -LiteralPath $AgentStateDir)) {
        New-Item -ItemType Directory -Path $AgentStateDir | Out-Null
    }
}

function Get-LastReadTimestamp {
    Initialize-AgentStateDir

    if (-not (Test-Path -LiteralPath $LastReadPath)) {
        return $null
    }

    $raw = (Get-Content -LiteralPath $LastReadPath -Raw).Trim()
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return $null
    }

    return [datetime]::Parse($raw).ToUniversalTime()
}

function Set-LastReadTimestamp {
    param(
        [datetime]$Timestamp
    )

    Initialize-AgentStateDir
    $Timestamp.ToUniversalTime().ToString("o") | Set-Content -LiteralPath $LastReadPath -Encoding UTF8
}

function Read-NewEvents {
    $lastRead = Get-LastReadTimestamp
    if (-not (Test-Path -LiteralPath $EventsPath)) {
        if ($null -eq $lastRead) {
            Set-LastReadTimestamp -Timestamp ([datetime]::UtcNow)
        }
        return @()
    }

    $lines = @(Get-Content -LiteralPath $EventsPath | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($lines.Count -eq 0) {
        if ($null -eq $lastRead) {
            Set-LastReadTimestamp -Timestamp ([datetime]::UtcNow)
        }
        return @()
    }

    $events = @($lines | ForEach-Object { $_ | ConvertFrom-Json })
    if ($null -eq $lastRead) {
        $latestTimestamp = [datetime]::Parse(($events | Select-Object -Last 1).timestamp).ToUniversalTime()
        Set-LastReadTimestamp -Timestamp $latestTimestamp
        return @()
    }

    $newEvents = @($events | Where-Object { [datetime]::Parse($_.timestamp).ToUniversalTime() -gt $lastRead })
    if ($newEvents.Count -gt 0) {
        $latestTimestamp = [datetime]::Parse(($newEvents | Select-Object -Last 1).timestamp).ToUniversalTime()
        Set-LastReadTimestamp -Timestamp $latestTimestamp
    }

    return $newEvents
}

function Show-BlockingCommands {
    param(
        [object[]]$Commands
    )

    foreach ($cmd in $Commands) {
        Write-Host ("BLOCKING COMMAND [{0}] target={1} by={2}" -f $cmd.id, $cmd.target_agent, $cmd.created_by)
        Write-Host ("  {0}" -f $cmd.text)
    }
}

function Show-NewEvents {
    param(
        [object[]]$Events
    )

    foreach ($boardEvent in $Events) {
        $parts = @()
        $parts += ("{0}" -f $boardEvent.timestamp)
        $parts += ("[{0}]" -f $boardEvent.type)
        if (-not [string]::IsNullOrWhiteSpace($boardEvent.agent)) {
            $parts += ("{0}:" -f $boardEvent.agent)
        }

        $line = ($parts -join " ").Trim()
        if (-not [string]::IsNullOrWhiteSpace($boardEvent.message)) {
            $line = "{0} {1}" -f $line, $boardEvent.message
        }

        Write-Host ("BOARD UPDATE {0}" -f $line.Trim())

        $paths = @($boardEvent.paths)
        if ($paths.Count -gt 0) {
            Write-Host ("  paths: {0}" -f ($paths -join ", "))
        }
    }
}

if ($Mode -eq "check") {
    $blocking = @(Get-BlockingCommands -AgentName $Agent)
    if ($blocking.Count -eq 1 -and $null -eq $blocking[0]) {
        $blocking = @()
    }
    if ($blocking.Count -gt 0) {
        Show-BlockingCommands -Commands $blocking
        exit 2
    }

    $newEvents = @(Read-NewEvents)
    if ($newEvents.Count -gt 0) {
        Show-NewEvents -Events $newEvents
    } else {
        Write-Host "No blocking commands. No new board entries."
    }

    exit 0
}

while ($true) {
    $blocking = @(Get-BlockingCommands -AgentName $Agent)
    if ($blocking.Count -eq 1 -and $null -eq $blocking[0]) {
        $blocking = @()
    }
    if ($blocking.Count -gt 0) {
        Show-BlockingCommands -Commands $blocking
        exit 2
    }

    $newEvents = @(Read-NewEvents)
    if ($newEvents.Count -gt 0) {
        Show-NewEvents -Events $newEvents
    }

    Start-Sleep -Seconds $IntervalSeconds
}
