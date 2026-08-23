# ============================================================================
# screen-connect 人声门控（Silero VAD）安装脚本（Windows）
# 下载 silero_vad.onnx（约 2MB）到 server\silero\，并安装 onnxruntime-node（可选依赖）
# 之后 config.yaml 里 asr.speechGate.enabled: true 即生效。
# 用法（在 server 目录下）：
#   powershell -ExecutionPolicy Bypass -File setup-silero-vad.ps1
# ============================================================================
$ErrorActionPreference = "Stop"
$DestDir = Join-Path $PSScriptRoot "silero"
New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
$ModelPath = Join-Path $DestDir "silero_vad.onnx"

Write-Host "[1/2] 下载 silero_vad.onnx ..."
$urls = @(
  "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx",
  "https://cdn.jsdelivr.net/gh/snakers4/silero-vad@master/src/silero_vad/data/silero_vad.onnx",
  "https://hf-mirror.com/csukuangfj/vad/resolve/main/silero_vad.onnx"
)
$ok = $false
if (Test-Path $ModelPath) {
  Write-Host "    已存在，跳过：$ModelPath"
  $ok = $true
}
foreach ($u in $urls) {
  if ($ok) { break }
  try {
    Write-Host "    尝试 $u"
    Invoke-WebRequest -Uri $u -OutFile $ModelPath -UseBasicParsing -TimeoutSec 60
    if ((Get-Item $ModelPath).Length -gt 100000) { $ok = $true }
  } catch { Remove-Item $ModelPath -ErrorAction SilentlyContinue }
}
if (-not $ok) {
  Write-Host "[error] 模型下载失败（GitHub / jsDelivr / hf-mirror 均不可用）。" -ForegroundColor Red
  Write-Host "        请手动下载后放到 $ModelPath ："
  Write-Host "        https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx"
  exit 1
}
$sizeKB = [math]::Round((Get-Item $ModelPath).Length / 1KB)
Write-Host "    -> silero\silero_vad.onnx (${sizeKB} KB)"

Write-Host "[2/2] 安装 onnxruntime-node（可选依赖，--no-save 不写入 package.json）..."
Push-Location $PSScriptRoot
try { npm install onnxruntime-node --no-save } finally { Pop-Location }

Write-Host ""
Write-Host "=== 完成 ==="
Write-Host "确认 server/config.yaml 中 asr.speechGate.enabled: true 后重启服务器。"
Write-Host "可先自测：node test-silero-gate.js"
