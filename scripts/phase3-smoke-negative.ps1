#requires -Version 7.0
$ErrorActionPreference = "Stop"

# Phase 3 negative smoke — Cloud API only. Requires PowerShell 7+ (uses Invoke-WebRequest -SkipHttpErrorCheck).
# Same env vars as phase3-smoke-test.ps1.

$BaseUrl = $(if ($env:PHASE3_BASE_URL -and $env:PHASE3_BASE_URL.Trim()) {
    $env:PHASE3_BASE_URL.TrimEnd('/')
  } else { "http://localhost:3000" })

$PortalToken = $(if ($env:PHASE3_PORTAL_TOKEN) { $env:PHASE3_PORTAL_TOKEN } else { "supersecret123" })
$AdminToken  = $(if ($env:PHASE3_ADMIN_TOKEN) { $env:PHASE3_ADMIN_TOKEN } else { "supersecret123" })
$PrinterId   = $(if ($env:PHASE3_PRINTER_ID) { $env:PHASE3_PRINTER_ID } else { "KIOSK_1" })
$AgentToken  = $(if ($env:PHASE3_AGENT_TOKEN) { $env:PHASE3_AGENT_TOKEN } else { "supersecret123" })

function Invoke-Json {
  param(
    [Parameter(Mandatory)] [string] $Method,
    [Parameter(Mandatory)] [string] $Url,
    [hashtable] $Headers = @{},
    $Body = $null
  )
  $h = @{}
  foreach ($k in $Headers.Keys) { $h[$k] = $Headers[$k] }
  $h["Accept"] = "application/json"
  if ($null -ne $Body) {
    $json = ($Body | ConvertTo-Json -Depth 20)
    return Invoke-RestMethod -Method $Method -Uri $Url -Headers $h -ContentType "application/json" -Body $json
  }
  return Invoke-RestMethod -Method $Method -Uri $Url -Headers $h
}

function Assert {
  param([bool] $Cond, [string] $Msg)
  if (-not $Cond) { throw "ASSERT FAILED: $Msg" }
}

function Invoke-ExpectError {
  param(
    [string] $Method,
    [string] $Url,
    [hashtable] $Headers,
    $Body = $null,
    [int[]] $ExpectedStatus,
    [string] $ExpectedErrorSubstring
  )
  $h = @{}
  foreach ($k in $Headers.Keys) { $h[$k] = $Headers[$k] }
  $h["Accept"] = "application/json"
  $req = @{
    Uri                = $Url
    Method             = $Method
    Headers            = $h
    SkipHttpErrorCheck = $true
  }
  if ($null -ne $Body) {
    $req.ContentType = "application/json"
    $req.Body = ($Body | ConvertTo-Json -Depth 20)
  }
  $r = Invoke-WebRequest @req
  Assert ($ExpectedStatus -contains [int]$r.StatusCode) "expected status in [$($ExpectedStatus -join ',')], got $($r.StatusCode) body=$($r.Content)"
  if ($ExpectedErrorSubstring) {
    $j = $null
    try { $j = $r.Content | ConvertFrom-Json } catch { }
    $err = $null
    if ($j) { $err = $j.error }
    Assert ($err -and ($err.ToString() -like "*$ExpectedErrorSubstring*")) "expected error containing '$ExpectedErrorSubstring', got '$err' full=$($r.Content)"
  }
}

Write-Host "== Phase 3 smoke (negative cases) =="

# N1) payment-intent before scan → SCAN_NOT_COMPLETED
$idKey = "smoke-neg-" + [guid]::NewGuid().ToString()
$create = Invoke-Json -Method POST -Url "$BaseUrl/api/portal/copy-sessions" -Headers @{
  Authorization     = "Bearer $PortalToken"
  "Idempotency-Key" = $idKey
} -Body @{
  scanKind = "scan_adf"
  options = @{ duplexRequested = $false }
}
Assert ($create.ok -eq $true) "create copy_session failed"
$NegSessionId = $create.copySession.id
$N1ScanJobId = [int]$create.copySession.scanJobId
Write-Host "N1 copy_session=$NegSessionId (no reserve/complete)"

Invoke-ExpectError -Method POST -Url "$BaseUrl/api/portal/copy-sessions/$NegSessionId/payment-intents" -Headers @{
  Authorization     = "Bearer $PortalToken"
  "Idempotency-Key" = ("neg-pi-" + [guid]::NewGuid().ToString())
} -Body $null -ExpectedStatus @(409) -ExpectedErrorSubstring "SCAN_NOT_COMPLETED"

# N1 leaves scan job in `queued`; jobs/next orders by created_at ASC.
# Queue may already contain older queued scan jobs from prior scenarios in the same CI run,
# so keep reserving/failing earlier jobs until we reach N1's scan job id.
$maxCleanupReserves = 20
$cleanupReservedIds = @()
$n1Found = $false

for ($i = 1; $i -le $maxCleanupReserves; $i++) {
  $n1Reserve = Invoke-Json -Method GET -Url "$BaseUrl/api/agent/jobs/next?printerId=$PrinterId&leaseSeconds=120" -Headers @{
    Authorization = "Bearer $AgentToken"
  }

  Assert ($n1Reserve.ok -eq $true) "N1 cleanup: reserve failed"

  $reservedJobId = [int]$n1Reserve.job.id
  $cleanupReservedIds += $reservedJobId

  if ($reservedJobId -eq $N1ScanJobId) {
    $n1Found = $true
    break
  }

  $cleanupFailOther = Invoke-Json -Method POST -Url "$BaseUrl/api/agent/jobs/$reservedJobId/fail?printerId=$PrinterId" -Headers @{
    Authorization = "Bearer $AgentToken"
  } -Body @{
    error = @{ code = "SMOKE_CLEANUP"; message = "phase3-smoke-negative cleanup before N1 target" }
  }

  Assert ($cleanupFailOther.ok -eq $true) "N1 cleanup: fail preceding job $reservedJobId failed"
}

Assert $n1Found "N1 cleanup: target scan job $N1ScanJobId was not found after reserved ids [$($cleanupReservedIds -join ', ')]"

$cleanupFail = Invoke-Json -Method POST -Url "$BaseUrl/api/agent/jobs/$N1ScanJobId/fail?printerId=$PrinterId" -Headers @{
  Authorization = "Bearer $AgentToken"
} -Body @{
  error = @{ code = "SMOKE_CLEANUP"; message = "phase3-smoke-negative N1 orphan" }
}
Assert ($cleanupFail.ok -eq $true) "N1 cleanup: fail failed"
Write-Host "N1 orphan scan job $N1ScanJobId failed after reserving ids [$($cleanupReservedIds -join ', ')] (queue clean for N2)"

# N2) trusted confirm with unknown paymentIntentId → PAYMENT_INTENT_NOT_FOUND
$idKey2 = "smoke-neg2-" + [guid]::NewGuid().ToString()
$c2 = Invoke-Json -Method POST -Url "$BaseUrl/api/portal/copy-sessions" -Headers @{
  Authorization     = "Bearer $PortalToken"
  "Idempotency-Key" = $idKey2
} -Body @{
  scanKind = "scan_adf"
  options = @{ duplexRequested = $false }
}
Assert ($c2.ok -eq $true) "create copy_session 2 failed"
$Sid = $c2.copySession.id
$Jid = [int]$c2.copySession.scanJobId

$n2 = Invoke-Json -Method GET -Url "$BaseUrl/api/agent/jobs/next?printerId=$PrinterId&leaseSeconds=300" -Headers @{
  Authorization = "Bearer $AgentToken"
}
Assert ($n2.ok -eq $true) "reserve failed for N2"
Assert ([int]$n2.job.id -eq $Jid) "wrong job reserved in N2"

$fn = "scan_neg_" + [guid]::NewGuid().ToString() + ".pdf"
$null = Invoke-Json -Method POST -Url "$BaseUrl/api/agent/jobs/$Jid/complete?printerId=$PrinterId" -Headers @{
  Authorization = "Bearer $AgentToken"
} -Body @{
  result = @{
    fileRef = $fn
    fileUrl = "/api/files/tmp/$fn"
    pages = 1
    price = 100
    uploadedAt = (Get-Date).ToUniversalTime().ToString("o")
  }
}

$pi2 = Invoke-Json -Method POST -Url "$BaseUrl/api/portal/copy-sessions/$Sid/payment-intents" -Headers @{
  Authorization     = "Bearer $PortalToken"
  "Idempotency-Key" = ("neg-pi2-" + [guid]::NewGuid().ToString())
}
Assert ($pi2.ok -eq $true) "payment intent N2 failed"

$badIntent = "00000000-0000-4000-8000-000000000099"
Invoke-ExpectError -Method POST -Url "$BaseUrl/api/internal/copy-sessions/$Sid/payment/confirm" -Headers @{
  Authorization = "Bearer $AdminToken"
} -Body @{ paymentIntentId = $badIntent } -ExpectedStatus @(404) -ExpectedErrorSubstring "PAYMENT_INTENT_NOT_FOUND"

Write-Host "== PASS (negative) =="
