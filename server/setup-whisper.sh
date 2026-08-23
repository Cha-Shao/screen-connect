#!/usr/bin/env bash
# ============================================================================
# screen-connect ASR 依赖安装脚本（Debian/Ubuntu Linux）
# 下载/编译 whisper-cli 与 ggml-base.bin（whisper base 模型）到 server/whisper/
# 之后在 config.yaml 中开启 asr.enabled 即可使用。
#
# 用法（在 server 目录下）：
#   bash setup-whisper.sh
#   可选：WHISPER_TAG=v1.7.6 bash setup-whisper.sh   # 指定版本 tag
# 前置依赖（Debian 12）：
#   sudo apt install -y curl unzip git cmake build-essential
#
# 获取 whisper-cli 的顺序：
#   1) GitHub 最新 release 的预编译包（模糊匹配 linux/ubuntu x64，zip/tar.gz 均可）
#   2) 固定版本 v1.7.6 的经典命名预编译包
#   3) 源码编译 whisper.cpp（最可靠，约 3-5 分钟）
# ============================================================================
set -euo pipefail

DEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/whisper"
mkdir -p "$DEST_DIR"

# 下载函数 dl <url> <outfile>（curl 优先，wget 兜底）
if command -v curl >/dev/null 2>&1; then
  dl() { curl -fSL -o "$2" "$1"; }
  HAVE_CURL=1
elif command -v wget >/dev/null 2>&1; then
  dl() { wget -q -O "$2" "$1"; }
  HAVE_CURL=0
else
  echo "[error] 未找到 curl/wget，请先安装：sudo apt install -y curl"
  exit 1
fi
if ! command -v unzip >/dev/null 2>&1; then
  echo "[error] 未找到 unzip，请先安装：sudo apt install -y unzip"
  exit 1
fi

# ---------------- 1. 获取 whisper-cli ----------------
echo "[1/3] 获取 whisper-cli ..."

download_and_extract() {
  local url="$1"
  local tmp
  tmp="$(mktemp -d)"
  echo "    下载 $url"
  if ! dl "$url" "$tmp/whisper.pkg"; then
    echo "    [warn] 下载失败，尝试其他来源"
    rm -rf "$tmp"
    return 1
  fi
  if printf '%s' "$url" | grep -qE '\.zip$'; then
    unzip -oq "$tmp/whisper.pkg" -d "$tmp/x" || { rm -rf "$tmp"; return 1; }
  else
    mkdir -p "$tmp/x"
    tar -xzf "$tmp/whisper.pkg" -C "$tmp/x" || { rm -rf "$tmp"; return 1; }
  fi
  local bin
  bin="$(find "$tmp/x" -type f -name 'whisper-cli' | head -1)"
  if [ -z "$bin" ]; then
    echo "    [warn] 压缩包中未找到 whisper-cli，尝试其他来源"
    rm -rf "$tmp"
    return 1
  fi
  cp "$bin" "$DEST_DIR/whisper-cli"
  chmod +x "$DEST_DIR/whisper-cli"
  # 动态链接的构建还带有 libwhisper.so.1 / libggml*.so，必须一并拷走，否则运行时报找不到共享库
  find "$tmp/x" -type f \( -name 'lib*.so' -o -name 'lib*.so.*' \) -exec cp -f {} "$DEST_DIR/" \;
  rm -rf "$tmp"
  return 0
}

build_from_source() {
  echo "    源码编译 whisper.cpp（约 3-5 分钟）..."
  local tmp
  tmp="$(mktemp -d)"
  ( git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$tmp/whisper.cpp" \
      && cd "$tmp/whisper.cpp" \
      && cmake -B build -DGGML_NATIVE=ON >/dev/null \
      && cmake --build build --config Release -j "$(nproc)" >/dev/null ) || { rm -rf "$tmp"; return 1; }
  local bin
  bin="$(find "$tmp/whisper.cpp/build" -type f -name 'whisper-cli' | head -1)"
  if [ -z "$bin" ]; then
    echo "    [error] 编译产物中未找到 whisper-cli"
    rm -rf "$tmp"
    return 1
  fi
  cp "$bin" "$DEST_DIR/whisper-cli"
  chmod +x "$DEST_DIR/whisper-cli"
  rm -rf "$tmp"
  return 0
}

TAG="${WHISPER_TAG:-}"
# 1) 从 GitHub API 解析最新 release 并模糊匹配 Linux x64 预编译包
API_JSON=""
if [ -z "$TAG" ] && [ "${HAVE_CURL:-0}" = "1" ]; then
  API_JSON="$(curl -fsSL -H 'User-Agent: screen-connect-setup' 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest' 2>/dev/null || true)"
fi
if [ -n "$API_JSON" ]; then
  TAG="$(printf '%s' "$API_JSON" | grep -o '"tag_name":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
  URL="$(printf '%s' "$API_JSON" | grep -oE '"browser_download_url":"[^"]*(ubuntu|linux|debian)[^"]*(x64|amd64|x86_64)[^"]*\.(zip|tar\.gz|tgz)"' \
    | sed 's/.*"browser_download_url":"//; s/"$//' | head -1 || true)"
  if [ -n "$URL" ]; then
    echo "    发现最新 release: $TAG"
    download_and_extract "$URL" || true   # 失败不退出，继续下面的回退
  else
    echo "    [warn] release $TAG 中没有匹配的 Linux 预编译包，继续尝试其他来源"
  fi
fi

# 2) 固定版本 v1.7.6（经典命名）
if [ ! -f "$DEST_DIR/whisper-cli" ]; then
  TAG="${TAG:-v1.7.6}"
  echo "    回退固定版本 $TAG"
  download_and_extract "https://github.com/ggml-org/whisper.cpp/releases/download/${TAG}/whisper-cpp-${TAG}-ubuntu-x64.zip" \
    || download_and_extract "https://github.com/ggml-org/whisper.cpp/releases/download/${TAG}/whisper-cpp-${TAG}-linux-x64.zip" \
    || download_and_extract "https://github.com/ggml-org/whisper.cpp/releases/download/${TAG}/whisper-cpp-${TAG}-ubuntu-x64.tar.gz" \
    || true
fi

# 3) 源码编译
if [ ! -f "$DEST_DIR/whisper-cli" ]; then
  for c in git cmake g++ make; do
    if ! command -v "$c" >/dev/null 2>&1; then
      echo "[error] 源码编译需要 $c，请先安装：sudo apt install -y git cmake build-essential"
      exit 1
    fi
  done
  build_from_source || true
fi
if [ ! -f "$DEST_DIR/whisper-cli" ]; then
  echo "[error] whisper-cli 获取失败。请手动编译 whisper.cpp 后把 whisper-cli 放到 $DEST_DIR/"
  exit 1
fi
echo "    -> whisper/whisper-cli"

# ---------------- 2. 下载 ggml-base.bin（约 75MB） ----------------
echo "[2/3] 下载 ggml-base.bin ..."

check_model() {
  [ -s "$1" ] && head -c 4 "$1" | grep -qiE 'ggml'
}

got=0
# 2a) 优先从 GitHub release 资产下载（国内网络通常比 HF 稳）
if [ -n "$API_JSON" ]; then
  MODEL_URL="$(printf '%s' "$API_JSON" | grep -oE '"browser_download_url":"[^"]*ggml-base\.bin"' | sed 's/.*"browser_download_url":"//; s/"$//' | head -1 || true)"
  if [ -n "$MODEL_URL" ]; then
    echo "    从 GitHub release 下载模型"
    if dl "$MODEL_URL" "$DEST_DIR/ggml-base.bin" && check_model "$DEST_DIR/ggml-base.bin"; then got=1; fi
  fi
fi
# 2b) HuggingFace
if [ "$got" = "0" ]; then
  echo "    从 HuggingFace 下载模型"
  if dl 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin' "$DEST_DIR/ggml-base.bin" && check_model "$DEST_DIR/ggml-base.bin"; then got=1; fi
fi
# 2c) HF 国内镜像
if [ "$got" = "0" ]; then
  echo "    从 hf-mirror.com 镜像下载模型"
  if dl 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin' "$DEST_DIR/ggml-base.bin" && check_model "$DEST_DIR/ggml-base.bin"; then got=1; fi
fi
if [ "$got" = "0" ]; then
  rm -f "$DEST_DIR/ggml-base.bin"
  echo "[error] 模型下载失败（GitHub/HuggingFace/hf-mirror 均不可用）。"
  echo "        请手动下载 ggml-base.bin 放到 $DEST_DIR/ 后重跑本脚本："
  echo "        https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
  echo "        （国内可用 https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin）"
  exit 1
fi
echo "    -> whisper/ggml-base.bin"

# ---------------- 3. 验证 ----------------
echo "[3/3] 验证 ..."
if [ -x "$DEST_DIR/whisper-cli" ] && check_model "$DEST_DIR/ggml-base.bin"; then
  echo ""
  echo "=== 安装完成 ==="
  echo "whisper-cli: $DEST_DIR/whisper-cli"
  echo "模型        : $DEST_DIR/ggml-base.bin"
  echo ""
  echo "接下来：确认 server/config.yaml 中 asr.enabled: true 后重启服务器，"
  echo "客户端进入房间点底部\"📝 转写\"即可。"
  echo "也可以先手动验证：$DEST_DIR/whisper-cli -m $DEST_DIR/ggml-base.bin -f <某个.wav>"
else
  echo "[error] 安装不完整，请检查上方错误信息"
  exit 1
fi
