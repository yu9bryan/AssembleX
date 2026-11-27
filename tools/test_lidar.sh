#!/bin/bash
# LiDAR 路線合成測試：tools/test_lidar.sh [元件 id…]
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p tools/out
swiftc -O -o tools/out/lidar_cli AssembleX/Vision/*.swift tools/lidar_cli/main.swift
tools/out/lidar_cli "$@"
