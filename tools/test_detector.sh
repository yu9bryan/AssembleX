#!/bin/bash
# 在 Mac 上測孔位偵測：tools/test_detector.sh <圖片…>
# 疊圖輸出到 tools/out/；綠＝看到的孔、橘＝推算（被擋住）、紫＝A1/J1/A63/J63 四角、實心紫＝A1。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p tools/out
swiftc -O -o tools/out/detect_cli AssembleX/Vision/BreadboardDetector.swift AssembleX/Vision/BreadboardRails.swift tools/detect_cli/main.swift
for f in "$@"; do
  name="$(basename "${f%.*}")"
  printf '%-28s ' "$name"
  tools/out/detect_cli "$f" "tools/out/${name}_overlay.png"
done
