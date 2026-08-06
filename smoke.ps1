# Smoke-тест merge/stage-1-tenant-context на копии данных (data-smoke).
# Ничего не трогает в data/ — только читает API на 127.0.0.1:3999.
$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:3999'
$envFile = Join-Path $PSScriptRoot '.env'
$adminToken = ((Get-Content $envFile | Where-Object { $_ -match '^ADMIN_TOKEN=' }) -replace '^ADMIN_TOKEN=', '')

$pass = 0; $fail = 0
function Check($name, $cond) {
    if ($cond) { Write-Host "OK   $name"; $script:pass++ }
    else       { Write-Host "FAIL $name"; $script:fail++ }
}

# 1. Витрина: публичный список товаров
try {
    $products = Invoke-RestMethod "$base/api/products" -TimeoutSec 5
    Check "витрина отдаёт товары (count=$($products.Count))" ($products.Count -gt 0)
    Check "скрытые товары не попадают в витрину" (($products | Where-Object { $_.hidden }) -eq $null -or @($products | Where-Object { $_.hidden }).Count -eq 0)
} catch { Check "витрина отдаёт товары" $false }

# 2. Админка: авторизация только через заголовок x-admin-token (логин-эндпоинта нет)
$h = @{ 'x-admin-token' = $adminToken }

# 3. Админка: товары, заказы, статистика
try {
    $admProducts = Invoke-RestMethod "$base/api/admin/products" -Headers $h -TimeoutSec 5
    Check "админ видит товары (count=$($admProducts.Count))" ($admProducts.Count -gt 0)

    $orders = Invoke-RestMethod "$base/api/admin/orders" -Headers $h -TimeoutSec 5
    Check "заказы читаются" ($orders -ne $null)

    $stats = Invoke-RestMethod "$base/api/admin/stats" -Headers $h -TimeoutSec 5
    Check "статистика отдаётся" ($stats -ne $null)
} catch { Check "админские эндпоинты ($($_.Exception.Message))" $false }

# 4. Неверный токен отвергается
try {
    $bad = Invoke-WebRequest "$base/api/admin/products" -Headers @{ 'x-admin-token' = 'wrong-token-123' } -TimeoutSec 5 -ErrorAction Stop
    Check "неверный токен отвергается" $false
} catch {
    Check "неверный токен отвергается (status=$($_.Exception.Response.StatusCode.value__))" ([int]$_.Exception.Response.StatusCode -ge 400)
}

# 5. Статика Mini App и админки (админка живёт в боте: браузеру без токена закрыта)
try {
    $idx = Invoke-WebRequest "$base/" -TimeoutSec 5
    $adm = Invoke-WebRequest "$base/admin.html?token=$adminToken" -TimeoutSec 5
    Check "витрина / отдаётся" ($idx.StatusCode -eq 200)
    Check "админка отдаётся с аварийным токеном" ($adm.StatusCode -eq 200)
} catch { Check "статика отдаётся ($($_.Exception.Message))" $false }
try {
    $null = Invoke-WebRequest "$base/admin.html" -TimeoutSec 5 -ErrorAction Stop
    Check "админка браузеру без токена закрыта" $false
} catch {
    Check "админка браузеру без токена закрыта (404)" ([int]$_.Exception.Response.StatusCode -eq 404)
}

Write-Host ""
Write-Host "Smoke: $pass ok, $fail fail"
exit $fail
