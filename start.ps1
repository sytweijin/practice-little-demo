# 在场 — AI 记忆工坊 启动脚本
Write-Host "╔════════════════════════════════════╗" -ForegroundColor Yellow
Write-Host "║     在场 — AI 记忆工坊             ║" -ForegroundColor Yellow
Write-Host "║     Presence Memory Workshop        ║" -ForegroundColor Yellow
Write-Host "╚════════════════════════════════════╝" -ForegroundColor Yellow
Write-Host ""

# Check Python
try {
    $py = (Get-Command python).Source
    Write-Host "✓ Python: $py" -ForegroundColor Green
} catch {
    Write-Host "✗ Python not found. Please install Python 3.10+" -ForegroundColor Red
    pause
    exit
}

# Install deps if needed
if (-not (Test-Path "requirements.txt")) {
    Write-Host "✗ requirements.txt not found" -ForegroundColor Red
    pause
    exit
}

Write-Host "→ Checking dependencies..." -ForegroundColor Cyan
$deps = Get-Content "requirements.txt"
$missing = @()
foreach ($dep in $deps) {
    $dep = $dep.Trim()
    if ($dep -and (-not $dep.StartsWith("#"))) {
        $found = python -c "import $($dep -replace '\[.*\]','')" 2>$null
        if (-not $?) { $missing += $dep }
    }
}
if ($missing.Count -gt 0) {
    Write-Host "  Installing missing: $($missing -join ', ')" -ForegroundColor Yellow
    pip install $missing
}

Write-Host ""
Write-Host "→ Starting server..." -ForegroundColor Cyan
Write-Host "  电脑访问: https://127.0.0.1:8001" -ForegroundColor Green
    Write-Host "  手机访问: 启动后看下方打印的地址（同一 WiFi）" -ForegroundColor Green
Write-Host "  Press Ctrl+C to stop" -ForegroundColor Yellow
Write-Host ""

python main.py
