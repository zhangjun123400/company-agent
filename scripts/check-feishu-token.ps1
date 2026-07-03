<#
.SYNOPSIS
    Feishu tenant_access_token health check script.
.DESCRIPTION
    Reads Feishu app credentials from ~/.claude/channels/feishu/.env,
    calls the token endpoint, and reports token status as JSON.
.PARAMETER Silent
    No output to stdout; exit code 0 = ok, 1 = error.
.PARAMETER Verbose
    Print verbose HTTP response details.
.PARAMETER EnvFile
    Path to the .env file containing FEISHU_APP_ID and FEISHU_APP_SECRET.
    Default: ~/.claude/channels/feishu/.env
.PARAMETER LogFile
    Path to append the health check log entry.
    Default: ~/.claude/channels/feishu/token-health.log
.EXAMPLE
    powershell -File check-feishu-token.ps1
    powershell -File check-feishu-token.ps1 -Verbose
    powershell -File check-feishu-token.ps1 -Silent
#>

param(
    [switch]$Silent,
    [switch]$Verbose,
    [string]$EnvFile,
    [string]$LogFile
)

$ErrorActionPreference = 'Stop'

# ── Resolve paths ──────────────────────────────────────────────────

$HOME_DIR = if ($env:USERPROFILE) { $env:USERPROFILE } else { $env:HOME }
if (-not $EnvFile) {
    $EnvFile = Join-Path $HOME_DIR '.claude\channels\feishu\.env'
}
if (-not $LogFile) {
    $LogFile = Join-Path $HOME_DIR '.claude\channels\feishu\token-health.log'
}

# ── Read credentials from .env ─────────────────────────────────────

if (-not (Test-Path $EnvFile)) {
    $result = @{
        status = 'error'
        has_token = $false
        expires_in_seconds = $null
        expires_at = $null
        error = ".env file not found: $EnvFile"
        timestamp = (Get-Date -Format 'o')
    }
    Write-Output ($result | ConvertTo-Json -Compress)
    exit 1
}

$appId = $null
$appSecret = $null
Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^\s*FEISHU_APP_ID\s*=\s*(.+)\s*$') { $appId = $Matches[1].Trim() }
    if ($_ -match '^\s*FEISHU_APP_SECRET\s*=\s*(.+)\s*$') { $appSecret = $Matches[1].Trim() }
}

if (-not $appId -or -not $appSecret) {
    $result = @{
        status = 'error'
        has_token = $false
        expires_in_seconds = $null
        expires_at = $null
        error = 'FEISHU_APP_ID or FEISHU_APP_SECRET missing in .env'
        timestamp = (Get-Date -Format 'o')
    }
    Write-Output ($result | ConvertTo-Json -Compress)
    exit 1
}

# ── Call Feishu token endpoint ─────────────────────────────────────

$body = @{
    app_id = $appId
    app_secret = $appSecret
} | ConvertTo-Json -Compress

$tokenUrl = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal'

if ($Verbose) {
    Write-Host "POST $tokenUrl"
    Write-Host "Body: $body"
}

try {
    $response = Invoke-RestMethod -Uri $tokenUrl -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 15

    if ($Verbose) {
        Write-Host "Response: $($response | ConvertTo-Json -Depth 3)"
    }

    if ($response.PSObject.Properties['tenant_access_token'] -and $response.PSObject.Properties['expire']) {
        $token = $response.tenant_access_token
        $expireSec = [int]$response.expire
        $expiresAt = (Get-Date).AddSeconds($expireSec)

        $result = @{
            status = 'ok'
            has_token = $true
            token_preview = $token.Substring(0, [Math]::Min(12, $token.Length)) + '...'
            expires_in_seconds = $expireSec
            expires_at = $expiresAt.ToString('o')
            error = $null
            timestamp = (Get-Date -Format 'o')
        }

        $json = $result | ConvertTo-Json -Compress
        if (-not $Silent) { Write-Output $json }

        # Append to log file
        try {
            $logDir = Split-Path $LogFile -Parent
            if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
            Add-Content -Path $LogFile -Value $json -Encoding UTF8
        } catch {
            # Logging failure is non-fatal
        }

        exit 0
    }
    else {
        $result = @{
            status = 'error'
            has_token = $false
            expires_in_seconds = $null
            expires_at = $null
            error = "Response missing tenant_access_token or expire field: $($response | ConvertTo-Json -Compress)"
            timestamp = (Get-Date -Format 'o')
        }
        Write-Output ($result | ConvertTo-Json -Compress)
        exit 1
    }
}
catch {
    $errMsg = $_.Exception.Message
    if ($_.Exception.Response) {
        try {
            $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
            $respBody = $reader.ReadToEnd()
            $errMsg += " | response: $respBody"
        } catch {}
    }

    $result = @{
        status = 'error'
        has_token = $false
        expires_in_seconds = $null
        expires_at = $null
        error = $errMsg
        timestamp = (Get-Date -Format 'o')
    }

    $json = $result | ConvertTo-Json -Compress
    if (-not $Silent) { Write-Output $json }

    # Append to log even on error
    try {
        $logDir = Split-Path $LogFile -Parent
        if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
        Add-Content -Path $LogFile -Value $json -Encoding UTF8
    } catch {}

    exit 1
}
