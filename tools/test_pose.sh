#!/bin/bash
# 在 Mac 上測 L298N 6DoF 定位：tools/test_pose.sh <圖片…>
# 疊圖輸出到 tools/out/；青＝擬合的 PCB 外框、紅綠藍＝物件 XYZ 軸、黃點＝端子／安裝孔標註點。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p tools/out
swiftc -O -o tools/out/pose_cli AssembleX/Vision/*.swift tools/pose_cli/main.swift
for f in "$@"; do
  name="$(basename "${f%.*}")"
  printf '%-26s ' "$name"
  tools/out/pose_cli "$f" "tools/out/${name}_pose.png"
done
