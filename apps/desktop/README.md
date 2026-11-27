# AssembleX Studio

桌面端工程工作站。整個 App 是一個 **3D 空間**：實體電路在空間中央，
所有面板（元件庫、電氣驗證、需求輸入）都是空間裡的**懸浮玻璃視窗**，
有自己的世界座標、會跟著視角轉、可以拖動 —— 不是貼在螢幕邊的 2D 側欄。

## 跑起來

```bash
npm install          # 在 repo 根目錄跑一次就好（npm workspaces）
npm run dev          # → http://localhost:5180
```

## 現在有什麼

| 區塊 | 檔案 | 狀態 |
|---|---|---|
| CircuitIR（邏輯／實體／執行三層） | `packages/circuit-schema/src/circuit-ir.ts` | 完成，zod 驗證 |
| Component Profile（電氣＋腳位＋幾何） | `packages/circuit-schema/src/component-profile.ts` | 完成 |
| 麵包板拓樸（830 孔、tie group） | `packages/circuit-schema/src/breadboard.ts` | 完成，10 個測試 |
| 電氣驗證（Union-Find） | `packages/circuit-schema/src/netlist.ts` | 完成，9 個測試 |
| Liquid Glass 設計系統 | `src/styles/glass.css` | 完成 |
| 空間懸浮視窗 | `src/spatial/FloatingWindow.tsx` | 完成 |
| 3D 麵包板／元件／導線 | `src/engine3d/` | placeholder 幾何，待換 GLB |
| 元件庫（4 個 profile） | `src/data/components/` | UNO R3 / LED / 電阻 / 麵包板 |

## 設計系統

`glass.css` 的 token 是桌面與 iOS 共用的語彙，改這裡兩端一起變：

- `--glass` / `--glass-raised` / `--glass-sunken` — 三層材質，對應 iOS 的
  `.ultraThinMaterial` / `.regularMaterial` / 凹陷輸入框
- `--stroke-top` + `--shadow-panel` — 內緣高光加外部陰影才有玻璃厚度，缺一就變灰片
- `--r-panel` 28px / `--r-card` 20px / `--r-row` 13px — 連續大圓角

## 還沒做

- Tauri 殼（需要 Rust；前端已經可以直接包進去）
- 真的 GLB 模型（目前是程序化 placeholder）
- 元件拖放擺放、導線互動繪製
- Agent Backend、模擬引擎、Arduino CLI
- UNO 的腳位座標是依標準排針間距推算的**暫定值**，`evidence` 裡標成 `unverified`，
  正式資料必須由 CAD 量測取得

## 座標系約定

- 單位 mm，右手系 Y-up
- 元件原點 = 底面中心；麵包板原點 = 左前角
- 場景裡 1 mm = 0.01 世界單位（`App.tsx` 的 `MM`）
- 這套約定要和 iOS 端 `AssembleX/Vision/` 的 CAD 座標系一致，之後對齊時以這裡為準
