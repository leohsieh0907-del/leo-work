# ─────────────────────────────────────────────────────────────
# Leo work 一鍵環境設定（Windows / PowerShell）
# 用法：在專案根目錄執行  ./scripts/setup.ps1
# ─────────────────────────────────────────────────────────────
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
function Test-Cmd($n) { return [bool](Get-Command $n -ErrorAction SilentlyContinue) }

Write-Host "`n=== Leo work 環境設定 ===`n" -ForegroundColor Cyan

# 1) 前端 + sidecar 依賴
Write-Host "[1/3] npm install（含 LanceDB / ONNX / ffmpeg 原生套件，較久）…" -ForegroundColor Yellow
npm install

# 2) Rust（僅 Tauri 外殼打包需要；純 Web/sidecar 開發不需要）
Write-Host "`n[2/3] 檢查 Rust（Tauri 外殼用；如只跑 npm run dev 可略過）…" -ForegroundColor Yellow
if (Test-Cmd rustc) {
    Write-Host "  ✓ $(rustc --version)"
} else {
    Write-Host "  ✗ 未安裝 Rust。要打包桌面版才需要：https://rustup.rs" -ForegroundColor Yellow
    Write-Host "    另需 Visual Studio Build Tools（Desktop C++）與 WebView2 Runtime。"
}

# 3) .env
Write-Host "`n[3/3] 環境變數…" -ForegroundColor Yellow
if (-not (Test-Path (Join-Path $root ".env"))) {
    Copy-Item (Join-Path $root ".env.example") (Join-Path $root ".env")
    Write-Host "  已建立 .env，請填入 ANTHROPIC_API_KEY，並把 ENCRYPTION_SALT 改成隨機長字串。" -ForegroundColor Cyan
} else {
    Write-Host "  ✓ .env 已存在"
}

Write-Host "`n=== 完成 ===" -ForegroundColor Green
Write-Host "驗證：    npm run typecheck ; npm test"
Write-Host "開發：    npm run tauri:dev  （或 npm run dev 只開 web+sidecar）`n"
