#!/bin/bash
# 建置（自動簽章）→ 安裝到實機 → 啟動。
# 若 Xcode 帳號又登入失敗（自動簽章失敗），參考 ../MecanumRC/deploy.sh 的手動簽章作法。
set -euo pipefail
cd "$(dirname "$0")"

DEVICE_ID="${DEVICE_ID:-D67C5B05-9ABB-5D88-BB26-80DF5FF50BEC}"   # Bryan_iPhone
BUNDLE_ID="yu8bryan.AssembleX"
export DEVELOPER_DIR="$HOME/Downloads/Xcode-beta.app/Contents/Developer"
APP="build/Build/Products/Release-iphoneos/AssembleX.app"   # Release：孔位偵測需要最佳化才夠快

echo "==> 產生專案"
xcodegen generate -q

echo "==> 建置"
xcodebuild -project AssembleX.xcodeproj -scheme AssembleX -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath build \
  -allowProvisioningUpdates build | grep -E 'error:|\*\* ' || true
[ -d "$APP" ] || { echo "建置失敗，找不到 $APP"; exit 1; }

echo "==> 安裝並啟動"
xcrun devicectl device install app --device "$DEVICE_ID" "$APP" | grep -E 'installed|bundleID|rror'
xcrun devicectl device process launch --device "$DEVICE_ID" --terminate-existing "$BUNDLE_ID"
