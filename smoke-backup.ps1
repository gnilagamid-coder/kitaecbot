# Smoke test for auto-backup feature over HTTP (data-smoke server).
# Full cycle: status -> config -> snapshot -> download -> restore.
# ASCII-only on purpose: PS 5.1 misreads UTF-8 Cyrillic in scripts.
$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:3999'
$envFile = Join-Path $PSScriptRoot '.env'
$token = ((Get-Content $envFile | Where-Object { $_ -match '^ADMIN_TOKEN=' }) -replace '^ADMIN_TOKEN=', '')
$h = @{ 'x-admin-token' = $token }

$pass = 0; $fail = 0
function Check($name, $cond) {
    if ($cond) { Write-Host "OK   $name"; $script:pass++ }
    else       { Write-Host "FAIL $name"; $script:fail++ }
}

# 1. Status: defaults on first run
$st = Invoke-RestMethod "$base/api/admin/backup" -Headers $h -TimeoutSec 10
Check "GET status (interval=$($st.config.intervalHours)h retention=$($st.config.retention))" ($st.config.intervalHours -eq 24 -and $st.config.retention -eq 10)

# 2. PUT config
$cfg = Invoke-RestMethod "$base/api/admin/backup" -Method Put -Headers $h -ContentType 'application/json' -Body '{"enabled":true,"intervalHours":12,"retention":5}' -TimeoutSec 10
Check "PUT saves config" ($cfg.enabled -eq $true -and $cfg.intervalHours -eq 12 -and $cfg.retention -eq 5)
$cfg2 = Invoke-RestMethod "$base/api/admin/backup" -Method Put -Headers $h -ContentType 'application/json' -Body '{"retention":9999}' -TimeoutSec 10
Check "PUT clamps garbage retention to $($cfg2.retention)" ($cfg2.retention -eq 100)
Invoke-RestMethod "$base/api/admin/backup" -Method Put -Headers $h -ContentType 'application/json' -Body '{"retention":5}' -TimeoutSec 10 | Out-Null

# 3. Manual snapshot
$run = Invoke-RestMethod "$base/api/admin/backup/run" -Method Post -Headers $h -TimeoutSec 30
Check "POST /run creates snapshot $($run.snapshot.name) files=$($run.snapshot.files)" ($run.ok -eq $true -and $run.snapshot.files -gt 0)
$name = $run.snapshot.name

# 4. Snapshot appears in the list
$st2 = Invoke-RestMethod "$base/api/admin/backup" -Headers $h -TimeoutSec 10
$found = $st2.snapshots | Where-Object { $_.name -eq $name }
Check "snapshot listed, size=$($found.size)B" ($found -ne $null -and $found.size -gt 0)

# 5. Download: gzip magic
$dl = Invoke-WebRequest "$base/api/admin/backup/download?name=$name" -Headers $h -TimeoutSec 60
Check "download 200 application/gzip" ($dl.StatusCode -eq 200 -and $dl.Headers['Content-Type'] -like 'application/gzip*')
Check "gzip magic bytes 1f 8b" ($dl.Content[0] -eq 0x1f -and $dl.Content[1] -eq 0x8b)

# 6. Traversal rejected
try {
    Invoke-WebRequest "$base/api/admin/backup/download?name=../escape" -Headers $h -TimeoutSec 10 -ErrorAction Stop | Out-Null
    Check "traversal rejected" $false
} catch { Check "traversal rejected (status=$([int]$_.Exception.Response.StatusCode))" ([int]$_.Exception.Response.StatusCode -ge 400) }

# 7. Restore from own snapshot
$rs = Invoke-RestMethod "$base/api/admin/backup/restore" -Method Post -Headers $h -ContentType 'application/json' -Body (@{ name = $name } | ConvertTo-Json) -TimeoutSec 60
Check "restore ok files=$($rs.files)" ($rs.ok -eq $true -and $rs.files -gt 0)

# 8. Storefront alive after restore
$products = Invoke-RestMethod "$base/api/products" -TimeoutSec 10
Check "storefront serves products after restore count=$($products.Count)" ($products.Count -gt 0)

# 9. No token -> 401
try {
    Invoke-WebRequest "$base/api/admin/backup" -TimeoutSec 10 -ErrorAction Stop | Out-Null
    Check "no-token rejected" $false
} catch { Check "no-token rejected (status=$([int]$_.Exception.Response.StatusCode))" ([int]$_.Exception.Response.StatusCode -eq 401) }

Write-Host ""
Write-Host "Backup smoke: $pass ok, $fail fail"
exit $fail
