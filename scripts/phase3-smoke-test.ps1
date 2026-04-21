#requires -Version 5.1
$ErrorActionPreference = "Stop"

# Phase 3 manual smoke — Cloud orchestration only (NOT Phase 2.5 / Pilot gate).
# Does NOT validate physical printing.
#
# Environment overrides (optional; for CI use fixed tokens matching print-cloud .env):
#   PHASE3_BASE_URL, PHASE3_PORTAL_TOKEN, PHASE3_ADMIN_TOKEN,
#   PHASE3_PRINTER_ID, PHASE3_AGENT_TOKEN

# ======== CONFIG ========
$BaseUrl = $(if ($env:PHASE3_BASE_URL -and $env:PHASE3_BASE_URL.Trim()) {
    $env:PHASE3_BASE_URL.TrimEnd('/')
  } else { "http://localhost:3000" })

$PortalToken = $(if ($env:PHASE3_PORTAL_TOKEN) { $env:PHASE3_PORTAL_TOKEN } else { "supersecret123" })
$AdminToken  = $(if ($env:PHASE3_ADMIN_TOKEN) { $env:PHASE3_ADMIN_TOKEN } else { "supersecret123" })
$PrinterId   = $(if ($env:PHASE3_PRINTER_ID) { $env:PHASE3_PRINTER_ID } else { "KIOSK_1" })
$AgentToken  = $(if ($env:PHASE3_AGENT_TOKEN) { $env:PHASE3_AGENT_TOKEN } else { "supersecret123" })

# ======== HELPERS ========
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

Write-Host "== Phase 3 smoke test (happy path) =="
Write-Host "BaseUrl=$BaseUrl PrinterId=$PrinterId"

# 1) create copy_session
$idKey = "smoke-" + [guid]::NewGuid().ToString()
$create = Invoke-Json -Method POST -Url "$BaseUrl/api/portal/copy-sessions" -Headers @{
  Authorization     = "Bearer $PortalToken"
  "Idempotency-Key" = $idKey
} -Body @{
  scanKind = "scan_adf"
  options = @{ duplexRequested = $false }
}

Assert ($create.ok -eq $true) "create copy_session failed"
$CopySessionId = $create.copySession.id
$ScanJobId = [int]$create.copySession.scanJobId
Write-Host "copy_session=$CopySessionId scan_job_id=$ScanJobId"

# 1.1) reserve the scan job (API: GET /api/agent/jobs/next)
$next = Invoke-Json -Method GET -Url "$BaseUrl/api/agent/jobs/next?printerId=$PrinterId&leaseSeconds=300" -Headers @{
  Authorization = "Bearer $AgentToken"
}

Assert ($next.ok -eq $true) "reserve next job failed"
Assert ($null -ne $next.job) "expected reserved job"
Assert ([int]$next.job.id -eq $ScanJobId) "reserved wrong job: expected $ScanJobId got $($next.job.id)"
Write-Host "reserved job id=$($next.job.id)"

# 2) simulate scan completion
$scanFileName = "scan_smoke_" + [guid]::NewGuid().ToString() + ".pdf"
$scanResult = @{
  fileRef    = $scanFileName
  fileUrl    = "/api/files/tmp/$scanFileName"
  pages      = 2
  price      = 200
  uploadedAt = (Get-Date).ToUniversalTime().ToString("o")
}

$complete = Invoke-Json -Method POST -Url "$BaseUrl/api/agent/jobs/$ScanJobId/complete?printerId=$PrinterId" -Headers @{
  Authorization = "Bearer $AgentToken"
} -Body @{
  result = $scanResult
}

Assert ($complete.ok -eq $true) "scan job complete simulation failed"
Write-Host "scan complete simulated"

# 2.1) verify scan→copy_session projection
$readAfterScan = Invoke-Json -Method GET -Url "$BaseUrl/api/portal/copy-sessions/$CopySessionId" -Headers @{
  Authorization = "Bearer $PortalToken"
}

Assert ($readAfterScan.ok -eq $true) "read after scan failed"
$csAfterScan = $readAfterScan.copySession

Assert ($csAfterScan.status -eq "payment_pending") "expected status=payment_pending after scan projection"
Assert ([int]$csAfterScan.pages -eq 2) "expected pages=2 after scan projection"
Assert ([int]$csAfterScan.price -eq 200) "expected price=200 after scan projection"

# 3) create payment intent
$piKey = "smoke-intent-" + [guid]::NewGuid().ToString()
$intent = Invoke-Json -Method POST -Url "$BaseUrl/api/portal/copy-sessions/$CopySessionId/payment-intents" -Headers @{
  Authorization     = "Bearer $PortalToken"
  "Idempotency-Key" = $piKey
}

Assert ($intent.ok -eq $true) "create payment intent failed"
Assert ($intent.paymentIntent.status -eq "pending") "expected paymentIntent.status=pending"
$PaymentIntentId = $intent.paymentIntent.id
Write-Host "payment_intent=$PaymentIntentId"

# 4) trusted confirm
$confirm = Invoke-Json -Method POST -Url "$BaseUrl/api/internal/copy-sessions/$CopySessionId/payment/confirm" -Headers @{
  Authorization = "Bearer $AdminToken"
} -Body @{
  paymentIntentId = $PaymentIntentId
}

Assert ($confirm.ok -eq $true) "trusted confirm failed"
Write-Host "trusted confirm OK"

# 4.1) replay trusted confirm (idempotent)
$confirmReplay = Invoke-Json -Method POST -Url "$BaseUrl/api/internal/copy-sessions/$CopySessionId/payment/confirm" -Headers @{
  Authorization = "Bearer $AdminToken"
} -Body @{
  paymentIntentId = $PaymentIntentId
}

Assert ($confirmReplay.ok -eq $true) "trusted confirm replay failed"

# 4.2) Portal GET side-effect free (two reads match)
$portalGetA = Invoke-Json -Method GET -Url "$BaseUrl/api/portal/copy-sessions/$CopySessionId" -Headers @{
  Authorization = "Bearer $PortalToken"
}
$portalGetB = Invoke-Json -Method GET -Url "$BaseUrl/api/portal/copy-sessions/$CopySessionId" -Headers @{
  Authorization = "Bearer $PortalToken"
}
Assert ($portalGetA.ok -eq $true) "portal GET A failed"
Assert ($portalGetB.ok -eq $true) "portal GET B failed"
$csA = $portalGetA.copySession
$csB = $portalGetB.copySession
Assert ($csA.status -eq $csB.status) "portal GET unstable: status"
Assert ($csA.paymentStatus -eq $csB.paymentStatus) "portal GET unstable: paymentStatus"
Assert ($csA.printJobId -eq $csB.printJobId) "portal GET unstable: printJobId"

# 5) final copy_session snapshot
$cs = $portalGetB.copySession
Write-Host ("copySession.status=" + $cs.status + " paymentStatus=" + $cs.paymentStatus + " printJobId=" + $cs.printJobId)

Assert ($cs.paymentStatus -eq "paid") "expected paymentStatus=paid"
Assert ($cs.status -eq "print_enqueued") "expected status=print_enqueued after trusted confirm"
Assert ($null -ne $cs.printJobId) "expected printJobId to be set"

# 6) PRIMARY: print job by id (no dependency on admin list ordering / pollution)
$printJobId = [int]$cs.printJobId
$jobDetail = Invoke-Json -Method GET -Url "$BaseUrl/api/admin/jobs/$printJobId" -Headers @{
  Authorization = "Bearer $AdminToken"
}
Assert ($jobDetail.ok -eq $true) "admin GET /api/admin/jobs/:id failed"
$pjRow = $jobDetail.job
Assert ([int]$pjRow.id -eq $printJobId) "admin job id mismatch"
Assert ($pjRow.payload.kind -eq "print") "expected payload.kind=print"

if ($pjRow.payload.source -and $pjRow.payload.source.copySessionId) {
  Assert ($pjRow.payload.source.copySessionId -eq $CopySessionId) "payload.source.copySessionId secondary check mismatch"
}

Write-Host "== PASS =="
