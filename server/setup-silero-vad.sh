#!/usr/bin/env bash
# ============================================================================
# screen-connect 人声门控（Silero VAD）安装脚本（Debian/Ubuntu Linux）
# 下载 silero_vad.onnx（约 2MB）到 server/silero/，并安装 onnxruntime-node（可选依赖）
# 之后 config.yaml 里 asr.speechGate.enabled: true 即生效：
#   - 送 ASR 前先本地判断有没有人声，鼓掌/环境音直接丢弃（省阿里云费用、避免"无内容 400 {}"）
#   - 依赖缺失时自动放行全部音频，不影响正常转写
#
# 用法（在 server 目录下）：
#   bash setup-silero-vad.sh
# 前置：node/npm 已安装（服务器本来就要跑 node server.js）
# ============================================================================
set -euo pipefail

DEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/silero"
mkdir -p "$DEST_DIR"

if command -v curl >/dev/null 2>&1; then
  dl() { curl -fSL --retry 2 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  dl() { wget -q -O "$2" "$1"; }
else
  echo "[error] 未找到 curl/wget，请先安装：sudo apt install -y curl"
  exit 1
fi

# ---------------- 1. 下载 silero_vad.onnx ----------------
echo "[1/2] 下载 silero_vad.onnx ..."
check_model() { [ -s "$1" ]; }

if check_model "$DEST_DIR/silero_vad.onnx"; then
  echo "    已存在，跳过：$DEST_DIR/silero_vad.onnx"
else
  # 依次尝试：GitHub 官方仓库 / jsDelivr CDN（国内可用）/ hf-mirror 镜像
  dl 'https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx' "$DEST_DIR/silero_vad.onnx" \
    || dl 'https://cdn.jsdelivr.net/gh/snakers4/silero-vad@master/src/silero_vad/data/silero_vad.onnx' "$DEST_DIR/silero_vad.onnx" \
    || dl 'https://hf-mirror.com/csukuangfj/vad/resolve/main/silero_vad.onnx' "$DEST_DIR/silero_vad.onnx" \
    || true
  if ! check_model "$DEST_DIR/silero_vad.onnx"; then
    rm -f "$DEST_DIR/silero_vad.onnx"
    echo "[error] 模型下载失败（GitHub / jsDelivr / hf-mirror 均不可用）。"
    echo "        请手动下载后放到 $DEST_DIR/ 并重跑本脚本："
    echo "        https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx"
    exit 1
  fi
  echo "    -> silero/silero_vad.onnx ($(du -h "$DEST_DIR/silero_vad.onnx" | cut -f1))"
fi

# ---------------- 2. 安装 onnxruntime-node ----------------
echo "[2/2] 安装 onnxruntime-node（可选依赖，--no-save 不写入 package.json）..."
npm install onnxruntime-node --no-save

echo ""
echo "=== 完成 ==="
echo "模型        : $DEST_DIR/silero_vad.onnx"
echo "onnxruntime : 已安装"
echo ""
echo "确认 server/config.yaml 中 asr.speechGate.enabled: true 后重启服务器。"
echo "可先自测：node test-silero-gate.js"
