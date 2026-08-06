# Restart smoke server via port lookup (WMI denied in sandbox).
$conn = Get-NetTCPConnection -LocalPort 3999 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    $procIds = $conn.OwningProcess | Select-Object -Unique
    foreach ($p in $procIds) { Stop-Process -Id $p -Force; Write-Host "killed pid=$p" }
    Start-Sleep -Seconds 2
} else { Write-Host "port 3999 free" }
Start-Process -FilePath 'node' -ArgumentList 'server/index.js' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
Start-Sleep -Seconds 2
try {
    $r = Invoke-WebRequest 'http://127.0.0.1:3999/api/products' -UseBasicParsing -TimeoutSec 5
    Write-Host "storefront up, status $($r.StatusCode)"
} catch { Write-Host "storefront NOT responding: $($_.Exception.Message)" }
# verify the new backup route exists (with token it must answer config JSON)
$envFile = Join-Path $PSScriptRoot '.env'
$token = ((Get-Content $envFile | Where-Object { $_ -match '^ADMIN_TOKEN=' }) -replace '^ADMIN_TOKEN=', '')
try {
    $b = Invoke-RestMethod 'http://127.0.0.1:3999/api/admin/backup' -Headers @{ 'x-admin-token' = $token } -TimeoutSec 5
    Write-Host "backup route OK: intervalHours=$($b.config.intervalHours) retention=$($b.config.retention)"
} catch { Write-Host "backup route MISSING: $($_.Exception.Message)" }
