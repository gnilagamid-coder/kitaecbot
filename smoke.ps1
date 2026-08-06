# Smoke test over the data-smoke copy. Reads API at 127.0.0.1:3999 only.
# ASCII-only on purpose: PS 5.1 misreads UTF-8 Cyrillic in scripts.
$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:3999'
$envFile = Join-Path $PSScriptRoot '.env'
$adminToken = ((Get-Content $envFile | Where-Object { $_ -match '^ADMIN_TOKEN=' }) -replace '^ADMIN_TOKEN=', '')

$pass = 0; $fail = 0
function Check($name, $cond) {
    if ($cond) { Write-Host "OK   $name"; $script:pass++ }
    else       { Write-Host "FAIL $name"; $script:fail++ }
}

# 1. Storefront: public product list
try {
    $products = Invoke-RestMethod "$base/api/products" -TimeoutSec 5
    Check "products served (count=$($products.Count))" ($products.Count -gt 0)
    Check "hidden products not exposed" (@($products | Where-Object { $_.hidden }).Count -eq 0)
} catch { Check "products served" $false }

# 2. Admin auth is x-admin-token header only (no login endpoint)
$h = @{ 'x-admin-token' = $adminToken }

# 3. Admin: products, orders, stats
try {
    $admProducts = Invoke-RestMethod "$base/api/admin/products" -Headers $h -TimeoutSec 5
    Check "admin products (count=$($admProducts.Count))" ($admProducts.Count -gt 0)

    $orders = Invoke-RestMethod "$base/api/admin/orders" -Headers $h -TimeoutSec 5
    Check "orders readable" ($orders -ne $null)

    $stats = Invoke-RestMethod "$base/api/admin/stats" -Headers $h -TimeoutSec 5
    Check "stats served" ($stats -ne $null)
} catch { Check "admin endpoints ($($_.Exception.Message))" $false }

# 4. Wrong token rejected
try {
    $bad = Invoke-WebRequest "$base/api/admin/products" -Headers @{ 'x-admin-token' = 'wrong-token-123' } -TimeoutSec 5 -ErrorAction Stop
    Check "wrong token rejected" $false
} catch {
    Check "wrong token rejected (status=$($_.Exception.Response.StatusCode.value__))" ([int]$_.Exception.Response.StatusCode -ge 400)
}

# 5. Static: mini app + admin login form (admin lives in the bot; emergency
# token is typed into the form field and never appears in the URL)
try {
    $idx = Invoke-WebRequest "$base/" -TimeoutSec 5
    $adm = Invoke-WebRequest "$base/admin.html" -TimeoutSec 5
    Check "storefront / served" ($idx.StatusCode -eq 200)
    Check "admin.html served as login form (no token in URL)" ($adm.StatusCode -eq 200)
} catch { Check "static served ($($_.Exception.Message))" $false }

Write-Host ""
Write-Host "Smoke: $pass ok, $fail fail"
exit $fail
