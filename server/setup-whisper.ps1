# ============================================================================
# screen-connect ASR 依赖安装脚本（Windows）
# 下载 whisper.cpp 预编译 whisper-cli.exe 与 ggml-base.bin（whisper base 模型）
# 到 server/whisper/ 目录。之后在 config.yaml 中开启 asr.enabled 即可使用。
#
# 用法（在 server 目录下）：
#   powershell -ExecutionPolicy Bypass -File setup-whisper.ps1
#   可选：$env:WHISPER_TAG='v1.7.6'; powershell ...setup-whisper.ps1
#
# 获取 whisper-cli.exe 的顺序：
#   1) GitHub 最新 release 的预编译包（模糊匹配 win-x64/windows-x64/amd64）
#   2) 固定版本 v1.7.6 的经典命名预编译包
# ============================================================================
$ErrorActionPreference = 'Stop'

$DestDir = Join-Path $PSScriptRoot 'whisper'
New-Item -ItemType Directory -Force -Path $DestDir | Out-Null

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Tag = $env:WHISPER_TAG

# ---- 1. 下载 whisper-cli.exe ----
Write-Host '[1/3] 下载 whisper-cli.exe ...'

function Download-And-Extract {
    param([string]$Url)
    $tmp = Join-Path $env:TEMP ("whisper-extract-" + [guid]::NewGuid().ToString('N'))
    $zip = Join-Path $env:TEMP ("whisper-" + [guid]::NewGuid().ToString('N') + '.zip')
    try {
        Write-Host "    下载 $Url"
        Invoke-WebRequest -Uri $Url -OutFile $zip -TimeoutSec 300
        Expand-Archive -Path $zip -DestinationPath $tmp -Force
        $cli = Get-ChildItem -Path $tmp -Recurse -Filter 'whisper-cli.exe' | Select-Object -First 1
        if (-not $cli) { Write-Host '    [warn] 压缩包中未找到 whisper-cli.exe，尝试其他来源'; return $false }
        Copy-Item -Path $cli.FullName -Destination (Join-Path $DestDir 'whisper-cli.exe') -Force
        return $true
    } catch {
        Write-Host "    [warn] 下载失败（$($_.Exception.Message)）"
        return $false
    } finally {
        Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -Path $zip -Force -ErrorAction SilentlyContinue
    }
}

$done = $false
if (-not $done -and -not $Tag) {
    # 1) GitHub API 最新 release 模糊匹配
    try {
        $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest' -Headers @{ 'User-Agent' = 'screen-connect-setup' } -TimeoutSec 30
        $Tag = $release.tag_name
        $asset = $release.assets | Where-Object { $_.name -match '(win|windows|x64|amd64).*\.zip$' -or $_.name -match '^whisper-cpp-.*\.zip$' } | Select-Object -First 1
        if ($asset) {
            Write-Host "    发现最新 release: $Tag"
            $done = Download-And-Extract $asset.browser_download_url
        } else {
            Write-Host "    [warn] release $Tag 中没有匹配的 Windows 预编译包，尝试其他来源"
        }
    } catch {
        Write-Host "    [warn] GitHub API 不可用（$($_.Exception.Message)），尝试固定版本"
    }
}

# 2) 固定版本 v1.7.6（经典命名）
if (-not $done) {
    $Tag = if ($Tag) { $Tag } else { 'v1.7.6' }
    Write-Host "    回退固定版本 $Tag"
    $done = Download-And-Extract "https://github.com/ggml-org/whisper.cpp/releases/download/$Tag/whisper-cpp-$Tag-win-x64.zip"
}
if (-not $done) {
    Write-Host '[error] whisper-cli.exe 下载失败。'
    Write-Host '       请手动编译 whisper.cpp（https://github.com/ggml-org/whisper.cpp）'
    Write-Host "       并把 whisper-cli.exe 放到 $DestDir"
    exit 1
}
Write-Host '    -> whisper/whisper-cli.exe'

# ---- 2. 下载 ggml-base.bin（约 75MB）----
Write-Host '[2/3] 下载 ggml-base.bin（约 75MB）...'
function Test-Model {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $false }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 4) { return $false }
    $magic = [System.Text.Encoding]::ASCII.GetString($bytes, 0, 4)
    return $magic -match 'ggml'
}
$gotModel = $false
# 2a) GitHub release 资产
try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/ggml-org/whisper.cpp/releases/tags/$Tag" -Headers @{ 'User-Agent' = 'screen-connect-setup' } -TimeoutSec 30
    $modelAsset = $release.assets | Where-Object { $_.name -eq 'ggml-base.bin' } | Select-Object -First 1
    if ($modelAsset) {
        Write-Host '    从 GitHub release 下载模型'
        $modelPath = Join-Path $DestDir 'ggml-base.bin'
        Invoke-WebRequest -Uri $modelAsset.browser_download_url -OutFile $modelPath -TimeoutSec 600
        if (Test-Model $modelPath) { $gotModel = $true }
    }
} catch { Write-Host '    [warn] GitHub release 模型不可用，尝试 HuggingFace' }
# 2b) HuggingFace
if (-not $gotModel) {
    Write-Host '    从 HuggingFace 下载模型'
    $modelPath = Join-Path $DestDir 'ggml-base.bin'
    try {
        Invoke-WebRequest -Uri 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin' -OutFile $modelPath -TimeoutSec 600
        if (Test-Model $modelPath) { $gotModel = $true }
    } catch { Write-Host '    [warn] HuggingFace 下载失败，尝试 hf-mirror' }
}
# 2c) hf-mirror（国内镜像）
if (-not $gotModel) {
    Write-Host '    从 hf-mirror.com 镜像下载模型'
    try {
        Invoke-WebRequest -Uri 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin' -OutFile $modelPath -TimeoutSec 600
        if (Test-Model $modelPath) { $gotModel = $true }
    } catch { Write-Host '    [warn] hf-mirror 下载失败' }
}
if (-not $gotModel) {
    Write-Host '[error] 模型下载失败（GitHub/HuggingFace/hf-mirror 均不可用）。'
    Write-Host "       请手动下载 ggml-base.bin 放到 $DestDir 后重跑本脚本"
    Write-Host '       https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin'
    Write-Host '       （国内可用 https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin）'
    exit 1
}
Write-Host '    -> whisper/ggml-base.bin'

# ---- 3. 验证 ----
Write-Host '[3/3] 验证...'
$cliExe = Join-Path $DestDir 'whisper-cli.exe'
if ((Test-Path $cliExe) -and (Test-Model (Join-Path $DestDir 'ggml-base.bin'))) {
    Write-Host ''
    Write-Host '=== 安装完成 ==='
    Write-Host "whisper-cli : $cliExe"
    Write-Host "模型        : $(Join-Path $DestDir 'ggml-base.bin')"
    Write-Host ''
    Write-Host '接下来：确认 server/config.yaml 中 asr.enabled: true 后重启服务器，'
    Write-Host '在客户端进入房间，点底部"📝 转写"按钮即可开始语音转写。'
    Write-Host '也可以先手动测一下：'
    Write-Host "  & '$cliExe' -m '$(Join-Path $DestDir 'ggml-base.bin')' -f <某个.wav>"
} else {
    Write-Host '[error] 安装不完整，请检查上方错误信息'
    exit 1
}
