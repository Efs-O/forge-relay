param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("claim", "release", "status", "post", "history", "clear-expired", "command", "ack", "commands", "resolve")]
    [string]$Action,

    [string]$Agent,

    [string[]]$Target = @(),

    [int]$TtlMinutes = 120,

    [string]$Note = "",

    [string]$TargetAgent = "all",

    [string]$CommandId = "",

    [object]$Since = $null
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path $PSScriptRoot -Parent
$CoordDir = Join-Path $RepoRoot ".coordination"
$ClaimsPath = Join-Path $CoordDir "claims.json"
$EventsPath = Join-Path $CoordDir "events.ndjson"
$CommandsPath = Join-Path $CoordDir "commands.json"
$LockPath = Join-Path $CoordDir "bridge.lock"

function Ensure-CoordinationStore {
    if (-not (Test-Path -LiteralPath $CoordDir)) {
        New-Item -ItemType Directory -Path $CoordDir | Out-Null
    }
    if (-not (Test-Path -LiteralPath $ClaimsPath)) {
        '{"claims":[]}' | Set-Content -LiteralPath $ClaimsPath -Encoding UTF8
    }
    if (-not (Test-Path -LiteralPath $EventsPath)) {
        New-Item -ItemType File -Path $EventsPath | Out-Null
    }
    if (-not (Test-Path -LiteralPath $CommandsPath)) {
        '{"commands":[]}' | Set-Content -LiteralPath $CommandsPath -Encoding UTF8
    }
}

function Use-Lock {
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock]$Script
    )

    $parent = Split-Path $LockPath -Parent
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent | Out-Null
    }

    $stream = $null
    for ($i = 0; $i -lt 100; $i++) {
        try {
            $stream = [System.IO.File]::Open($LockPath, "CreateNew", "ReadWrite", "None")
            break
        } catch {
            Start-Sleep -Milliseconds 100
        }
    }

    if ($null -eq $stream) {
        throw "Could not acquire coordination lock at $LockPath"
    }

    try {
        Ensure-CoordinationStore
        & $Script
    } finally {
        $stream.Dispose()
        if (Test-Path -LiteralPath $LockPath) {
            Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function Read-Claims {
    $raw = Get-Content -LiteralPath $ClaimsPath -Raw
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return [pscustomobject]@{ claims = @() }
    }
    return $raw | ConvertFrom-Json
}

function Write-Claims($state) {
    $json = $state | ConvertTo-Json -Depth 8
    Set-Content -LiteralPath $ClaimsPath -Value $json -Encoding UTF8
}

function Append-Event {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Type,
        [string]$AgentName = "",
        [string[]]$Paths = @(),
        [string]$Message = "",
        [object]$Meta = $null
    )

    $entry = [pscustomobject]@{
        timestamp = [DateTime]::UtcNow.ToString("o")
        type = $Type
        agent = $AgentName
        paths = $Paths
        message = $Message
        meta = $Meta
    }
    # Use FileShare.ReadWrite so watcher processes holding the file for reading do not block writes
    $stream = [System.IO.File]::Open($EventsPath, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    $writer = New-Object System.IO.StreamWriter($stream, [System.Text.Encoding]::UTF8)
    $writer.WriteLine(($entry | ConvertTo-Json -Compress))
    $writer.Close()
    $stream.Close()
}

function Read-Commands {
    $raw = Get-Content -LiteralPath $CommandsPath -Raw
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return [pscustomobject]@{ commands = @() }
    }
    return $raw | ConvertFrom-Json
}

function Write-Commands($state) {
    $json = $state | ConvertTo-Json -Depth 8
    Set-Content -LiteralPath $CommandsPath -Value $json -Encoding UTF8
}

function Normalize-Target {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InputPath
    )

    $candidate = $InputPath
    if (-not [System.IO.Path]::IsPathRooted($candidate)) {
        $candidate = Join-Path $RepoRoot $candidate
    }

    $full = [System.IO.Path]::GetFullPath($candidate)
    $repoFull = [System.IO.Path]::GetFullPath($RepoRoot)

    if (-not $full.StartsWith($repoFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Target is outside repo root: $InputPath"
    }

    $relative = $full.Substring($repoFull.Length).TrimStart('\')
    return $relative.Replace("\", "/")
}

function Prune-ExpiredClaims($state) {
    $now = [DateTime]::UtcNow
    $active = @()
    $expired = @()

    foreach ($claim in @($state.claims)) {
        $expires = [DateTime]::Parse($claim.expires_at)
        if ($expires -le $now) {
            $expired += $claim
        } else {
            $active += $claim
        }
    }

    $state.claims = @($active)
    foreach ($claim in $expired) {
        Append-Event -Type "expired" -AgentName $claim.agent -Paths @($claim.paths) -Message $claim.note
    }
    return $state
}

function Require-Agent {
    if ([string]::IsNullOrWhiteSpace($Agent)) {
        throw "Action '$Action' requires -Agent"
    }
}

function Resolve-SinceValue {
    if ($null -eq $Since) {
        return $null
    }

    if ($Since -is [datetime]) {
        return $Since.ToUniversalTime()
    }

    $raw = "$Since".Trim()
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return $null
    }

    return [datetime]::Parse($raw).ToUniversalTime()
}

function Read-EventHistory {
    $sinceValue = Resolve-SinceValue

    if (-not (Test-Path -LiteralPath $EventsPath)) {
        return @()
    }

    $lines = @(Get-Content -LiteralPath $EventsPath | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($lines.Count -eq 0) {
        return @()
    }

    $events = @($lines | ForEach-Object { $_ | ConvertFrom-Json })
    if ($null -ne $sinceValue) {
        $events = @($events | Where-Object { [datetime]::Parse($_.timestamp).ToUniversalTime() -gt $sinceValue })
    }

    return @($events)
}

Use-Lock {
    $state = Read-Claims
    $state = Prune-ExpiredClaims $state
    $commandsState = Read-Commands

    switch ($Action) {
        "claim" {
            Require-Agent
            if ($Target.Count -eq 0) {
                throw "claim requires at least one -Target"
            }

            $normalizedTargets = @($Target | ForEach-Object { Normalize-Target $_ } | Sort-Object -Unique)
            $conflicts = @()

            foreach ($claim in @($state.claims)) {
                foreach ($path in @($claim.paths)) {
                    if ($normalizedTargets -contains $path -and $claim.agent -ne $Agent) {
                        $conflicts += [pscustomobject]@{
                            path = $path
                            agent = $claim.agent
                            expires_at = $claim.expires_at
                            note = $claim.note
                        }
                    }
                }
            }

            if ($conflicts.Count -gt 0) {
                $table = ($conflicts | Format-Table -AutoSize | Out-String)
                throw "CLAIM DENIED`n$table"
            }

            $state.claims = @($state.claims | Where-Object {
                -not (($_.agent -eq $Agent) -and (@($_.paths) | Sort-Object) -join "|" -eq ($normalizedTargets | Sort-Object) -join "|")
            })

            $now = [DateTime]::UtcNow
            $claim = [pscustomobject]@{
                agent = $Agent
                paths = $normalizedTargets
                claimed_at = $now.ToString("o")
                expires_at = $now.AddMinutes($TtlMinutes).ToString("o")
                note = $Note
            }

            $state.claims = @($state.claims) + @($claim)
            Write-Claims $state
            Append-Event -Type "claim" -AgentName $Agent -Paths $normalizedTargets -Message $Note
            Write-Host "CLAIMED"
            $state.claims | Where-Object { $_.agent -eq $Agent -and ((@($_.paths) | Sort-Object) -join "|" -eq ($normalizedTargets | Sort-Object) -join "|") } | Format-Table -AutoSize | Out-Host
        }

        "release" {
            Require-Agent
            if ($Target.Count -eq 0) {
                throw "release requires at least one -Target"
            }

            $normalizedTargets = @($Target | ForEach-Object { Normalize-Target $_ } | Sort-Object -Unique)
            $before = @($state.claims).Count
            $state.claims = @($state.claims | Where-Object {
                if ($_.agent -ne $Agent) { return $true }
                $claimPaths = @($_.paths | Sort-Object)
                $targetPaths = @($normalizedTargets | Sort-Object)
                return (($claimPaths -join "|") -ne ($targetPaths -join "|"))
            })
            $after = @($state.claims).Count
            $releasedCount = $before - $after
            if ($releasedCount -le 0) {
                throw "No matching claim found to release."
            }

            Write-Claims $state
            Append-Event -Type "release" -AgentName $Agent -Paths $normalizedTargets -Message $Note
            Write-Host ("RELEASED {0} claim(s)" -f $releasedCount)
        }

        "status" {
            Write-Claims $state
            if (@($state.claims).Count -eq 0) {
                Write-Host "No active claims."
            } else {
                @($state.claims) |
                    Sort-Object expires_at, agent |
                    Format-Table agent, claimed_at, expires_at, note, @{Label="paths"; Expression={ ($_.paths -join ", ") }} -AutoSize |
                    Out-Host
            }
        }

        "post" {
            Require-Agent
            Append-Event -Type "post" -AgentName $Agent -Paths @() -Message $Note
            Write-Host "POSTED"
        }

        "command" {
            Require-Agent
            if ([string]::IsNullOrWhiteSpace($Note)) {
                throw "command requires -Note"
            }

            $now = [DateTime]::UtcNow
            if ([string]::IsNullOrWhiteSpace($CommandId)) {
                $CommandId = [Guid]::NewGuid().ToString("n")
            }

            $command = [pscustomobject]@{
                id = $CommandId
                created_at = $now.ToString("o")
                created_by = $Agent
                target_agent = $TargetAgent
                text = $Note
                status = "open"
                acknowledgements = @()
            }

            $commandsState.commands = @($commandsState.commands) + @($command)
            Write-Commands $commandsState
            Append-Event -Type "command" -AgentName $Agent -Message $Note -Meta ([pscustomobject]@{
                command_id = $CommandId
                target_agent = $TargetAgent
            })
            Write-Host "COMMAND POSTED $CommandId"
        }

        "ack" {
            Require-Agent
            if ([string]::IsNullOrWhiteSpace($CommandId)) {
                throw "ack requires -CommandId"
            }

            $found = $false
            $updated = @()
            foreach ($command in @($commandsState.commands)) {
                if ($command.id -eq $CommandId) {
                    $found = $true
                    $acks = @($command.acknowledgements)
                    if (-not ($acks | Where-Object { $_.agent -eq $Agent })) {
                        $acks += [pscustomobject]@{
                            agent = $Agent
                            acknowledged_at = [DateTime]::UtcNow.ToString("o")
                            note = $Note
                        }
                    }
                    $command.acknowledgements = @($acks)
                    if ($command.target_agent -eq "all") {
                        $command.status = "open"
                    } else {
                        $command.status = "acknowledged"
                    }
                }
                $updated += $command
            }

            if (-not $found) {
                throw "Unknown command id: $CommandId"
            }

            $commandsState.commands = @($updated)
            Write-Commands $commandsState
            Append-Event -Type "ack" -AgentName $Agent -Message $Note -Meta ([pscustomobject]@{
                command_id = $CommandId
            })
            Write-Host "ACKNOWLEDGED $CommandId"
        }

        "commands" {
            $open = @($commandsState.commands | Where-Object { $_.status -eq "open" -or $_.status -eq "acknowledged" })
            if ($Agent) {
                $open = @($open | Where-Object { $_.target_agent -eq "all" -or $_.target_agent -eq $Agent })
            }
            if ($open.Count -eq 0) {
                Write-Host "No open commands."
            } else {
                $open |
                    Select-Object id, created_at, created_by, target_agent, status, text |
                    Format-Table -AutoSize |
                    Out-Host
            }
        }

        "resolve" {
            Require-Agent
            if ([string]::IsNullOrWhiteSpace($CommandId)) {
                throw "resolve requires -CommandId"
            }

            $found = $false
            $updated = @()
            foreach ($command in @($commandsState.commands)) {
                if ($command.id -eq $CommandId) {
                    $found = $true
                    $command = [pscustomobject]@{
                        id = $command.id
                        created_at = $command.created_at
                        created_by = $command.created_by
                        target_agent = $command.target_agent
                        text = $command.text
                        status = "resolved"
                        acknowledgements = @($command.acknowledgements)
                        resolved_at = [DateTime]::UtcNow.ToString("o")
                        resolved_by = $Agent
                        resolution_note = $Note
                    }
                }
                $updated += $command
            }

            if (-not $found) {
                throw "Unknown command id: $CommandId"
            }

            $commandsState.commands = @($updated)
            Write-Commands $commandsState
            Append-Event -Type "resolve" -AgentName $Agent -Message $Note -Meta ([pscustomobject]@{
                command_id = $CommandId
            })
            Write-Host "RESOLVED $CommandId"
        }

        "history" {
            $events = @(Read-EventHistory)
            if ($events.Count -eq 0) {
                Write-Host "No history."
                return
            }

            $events |
                Select-Object timestamp, type, agent, message, @{Label="paths"; Expression={ ($_.paths -join ", ") }} |
                Format-Table -AutoSize |
                Out-Host
        }

        "clear-expired" {
            Write-Claims $state
            Write-Host "Expired claims cleared."
        }
    }
}
