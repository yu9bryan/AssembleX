#!/bin/bash
# 在 Mac 上測 AI 分割（Core ML）＋經典孔位偵測對照：tools/test_seg.sh <圖片…>
# 疊圖輸出到 tools/out/*_seg.png；SEG_CPU=1 只用 CPU。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p tools/out
xcrun coremlcompiler compile AssembleX/ML/BreadboardSeg.mlpackage tools/out >/dev/null
swiftc -O -o tools/out/seg_cli AssembleX/ML/BreadboardSegModel.swift AssembleX/ML/SeededDetection.swift AssembleX/ML/BoardPipeline.swift \
  AssembleX/Vision/BreadboardDetector.swift AssembleX/Vision/BreadboardRails.swift tools/seg_cli/main.swift
tools/out/seg_cli tools/out/BreadboardSeg.mlmodelc tools/out "$@"
