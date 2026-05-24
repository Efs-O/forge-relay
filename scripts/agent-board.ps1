param(
    [int]$Port = 8765
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path $MyInvocation.MyCommand.Path -Parent
$RepoRoot = Split-Path $ScriptDir -Parent
$BridgeScript = Join-Path $ScriptDir "agent-bridge.ps1"
$BoardHtml = Join-Path $ScriptDir "agent-board.html"
$CoordDir = Join-Path $RepoRoot ".coordination"
$ClaimsPath = Join-Path $CoordDir "claims.json"
$EventsPath = Join-Path $CoordDir "events.ndjson"
$CommandsPath = Join-Path $CoordDir "commands.json"

function Initialize-Store {
    if (-not (Test-Path -LiteralPath $CoordDir)) {
        New-Item -ItemType Directory -Path $CoordDir | Out-Null
    }
    if (-not (Test-Path -LiteralPath $ClaimsPath)) {
        '{"claims":[]}' | Set-Content -LiteralPath $ClaimsPath -Encoding UTF8
    }
    if (-not (Test-Path -LiteralPath $EventsPath)) {
        "" | Set-Content -LiteralPath $EventsPath -Encoding UTF8
    }
    if (-not (Test-Path -LiteralPath $CommandsPath)) {
        '{"commands":[]}' | Set-Content -LiteralPath $CommandsPath -Encoding UTF8
    }
}

function Read-State {
    Initialize-Store
    & $BridgeScript -Action clear-expired | Out-Null

    $claims = (Get-Content -LiteralPath $ClaimsPath -Raw | ConvertFrom-Json).claims
    $commands = (Get-Content -LiteralPath $CommandsPath -Raw | ConvertFrom-Json).commands
    $events = @()

    $lines = Get-Content -LiteralPath $EventsPath -ErrorAction SilentlyContinue |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

    if ($lines.Count -gt 0) {
        $events = @($lines | Select-Object -Last 200 | ForEach-Object { $_ | ConvertFrom-Json })
    }

    return [pscustomobject]@{
        generated_at = [DateTime]::UtcNow.ToString("o")
        claims = @($claims)
        commands = @($commands)
        events = @($events)
    }
}

function Read-RequestJson($Request) {
    $reader = New-Object System.IO.StreamReader($Request.InputStream, $Request.ContentEncoding)
    try {
        $body = $reader.ReadToEnd()
    } finally {
        $reader.Dispose()
    }

    if ([string]::IsNullOrWhiteSpace($body)) {
        return [pscustomobject]@{}
    }

    return $body | ConvertFrom-Json
}

function Write-Json($Response, $StatusCode, $Payload) {
    $json = $Payload | ConvertTo-Json -Depth 8
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $Response.StatusCode = $StatusCode
    $Response.ContentType = "application/json; charset=utf-8"
    $Response.ContentLength64 = $bytes.Length
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Response.OutputStream.Close()
}

function Write-Text($Response, $StatusCode, $ContentType, $Text) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    $Response.StatusCode = $StatusCode
    $Response.ContentType = $ContentType
    $Response.ContentLength64 = $bytes.Length
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Response.OutputStream.Close()
}

function Invoke-Bridge {
    param(
        [string]$Action,
        [string]$Agent,
        [string[]]$Target = @(),
        [int]$TtlMinutes = 120,
        [string]$Note = "",
        [string]$TargetAgent = "all",
        [string]$CommandId = ""
    )

    $params = @{
        Action = $Action
    }

    if ($Agent) { $params.Agent = $Agent }
    if ($Target.Count -gt 0) { $params.Target = $Target }
    if ($Action -eq "claim") { $params.TtlMinutes = $TtlMinutes }
    if ($Note) { $params.Note = $Note }
    if ($TargetAgent) { $params.TargetAgent = $TargetAgent }
    if ($CommandId) { $params.CommandId = $CommandId }

    & $BridgeScript @params | Out-Null
}

Initialize-Store

$listener = [System.Net.HttpListener]::new()
$prefix = "http://localhost:$Port/"
$listener.Prefixes.Add($prefix)
$listener.Start()

Write-Host "Agent board running at $prefix"
Write-Host "Press Ctrl+C to stop."

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response
        $path = $request.Url.AbsolutePath

        try {
            switch ($path) {
                "/" {
                    $html = Get-Content -LiteralPath $BoardHtml -Raw
                    Write-Text $response 200 "text/html; charset=utf-8" $html
                }

                "/api/state" {
                    Write-Json $response 200 (Read-State)
                }

                "/api/post" {
                    if ($request.HttpMethod -ne "POST") {
                        Write-Json $response 405 @{ error = "Method not allowed" }
                        break
                    }
                    $data = Read-RequestJson $request
                    Invoke-Bridge -Action "post" -Agent $data.agent -Note $data.note
                    Write-Json $response 200 @{ ok = $true; state = (Read-State) }
                }

                "/api/command" {
                    if ($request.HttpMethod -ne "POST") {
                        Write-Json $response 405 @{ error = "Method not allowed" }
                        break
                    }
                    $data = Read-RequestJson $request
                    Invoke-Bridge -Action "command" -Agent $data.agent -TargetAgent $data.targetAgent -Note $data.note
                    Write-Json $response 200 @{ ok = $true; state = (Read-State) }
                }

                "/api/ack" {
                    if ($request.HttpMethod -ne "POST") {
                        Write-Json $response 405 @{ error = "Method not allowed" }
                        break
                    }
                    $data = Read-RequestJson $request
                    Invoke-Bridge -Action "ack" -Agent $data.agent -CommandId $data.commandId -Note $data.note
                    Write-Json $response 200 @{ ok = $true; state = (Read-State) }
                }

                "/api/resolve" {
                    if ($request.HttpMethod -ne "POST") {
                        Write-Json $response 405 @{ error = "Method not allowed" }
                        break
                    }
                    $data = Read-RequestJson $request
                    Invoke-Bridge -Action "resolve" -Agent $data.agent -CommandId $data.commandId -Note $data.note
                    Write-Json $response 200 @{ ok = $true; state = (Read-State) }
                }

                "/api/claim" {
                    if ($request.HttpMethod -ne "POST") {
                        Write-Json $response 405 @{ error = "Method not allowed" }
                        break
                    }
                    $data = Read-RequestJson $request
                    Invoke-Bridge -Action "claim" -Agent $data.agent -Target @($data.targets) -TtlMinutes ([int]$data.ttlMinutes) -Note $data.note
                    Write-Json $response 200 @{ ok = $true; state = (Read-State) }
                }

                "/api/release" {
                    if ($request.HttpMethod -ne "POST") {
                        Write-Json $response 405 @{ error = "Method not allowed" }
                        break
                    }
                    $data = Read-RequestJson $request
                    Invoke-Bridge -Action "release" -Agent $data.agent -Target @($data.targets) -Note $data.note
                    Write-Json $response 200 @{ ok = $true; state = (Read-State) }
                }

                default {
                    Write-Json $response 404 @{ error = "Not found"; path = $path }
                }
            }
        } catch {
            Write-Json $response 500 @{
                ok = $false
                error = $_.Exception.Message
            }
        }
    }
} finally {
    $listener.Stop()
    $listener.Close()
}
