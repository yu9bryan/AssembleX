# 第三方 3D 模型出處與授權

## KiCad packages3D — CC-BY-SA 4.0（加 KiCad Library Exception）
來源：https://github.com/KiCad/kicad-packages3D　原始 `.wrl` 在 `src/`，轉檔腳本 `tools/wrl2gltf/wrl2glb.py`
（只做三角化與 ×2.54 單位換算，未改幾何）

| 檔案 | 原始檔 | 備註 |
|---|---|---|
| `led_5mm.glb` | `LED_THT.3dshapes/LED_D5.0mm.wrl` | |
| `resistor_axial.glb` | `Resistor_THT.3dshapes/R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal.wrl` | |
| `pushbutton_6mm.glb` | `Button_Switch_THT.3dshapes/SW_PUSH_6mm.wrl` | |
| `buzzer_12mm.glb` | `Buzzer_Beeper.3dshapes/Buzzer_12x9.5RM7.6.wrl` | |
| `kicad/*.glb` | STEP 經 cascadio 轉出（單位公尺、Z-up），尚未接入 | |

CC-BY-SA 義務：散布這些模型檔（含轉檔後的 `.glb`）須署名並以相同授權釋出。
Library Exception 只讓「使用這些模型的設計」免於 CC-BY-SA，模型檔本身仍受約束。

## FreeCAD-library — CC-BY 3.0
來源：https://github.com/FreeCAD/FreeCAD-library（repo 全庫 CC-BY 3.0），署名「FreeCAD-library contributors」。
STEP 經 cascadio／trimesh 轉成 mm、Y 朝上；幾何未改，只改顏色（`tools/partgen/fix_colors.py`）。

| 檔案 | 原始檔 | 備註 |
|---|---|---|
| `arduino_nano.glb` | `Computing/SingleBoardComputers/Arduino/Arduino Nano Rev3/Nano-Rev3_0.step` | 原檔單一材質，依高度分色（腳／排針座／PCB／零件） |
| `arduino_mega2560.glb` | `Computing/SingleBoardComputers/Arduino/Arduino Mega/arduino-mega.step` | R3 之前的排母配置（無左端 SDA/SCL、無 IOREF）；PCB 改為 Arduino 藍綠 |
| `esp32_devkit_v1.glb` | `Computing/SingleBoardComputers/ESP32/ESP32_DOIT_DevKit_v1/ESP32_DOIT_DevKit_V1.step` | PCB 改為黑色 |
| `hc_sr04.glb` | `Sensors/Ultrasonic Sensors/HC-SR04.step` | 原檔排針間距畫成 2.0mm（實物 2.54mm），兩端腳最多差 0.8mm |
| `sg90_servo.glb` | `Electrical Parts/Servos/SG-90/Servo-sg90.step` | 原檔沒有排線，排線與 3 針母座由程式補上 |

Leonardo 沒有授權模型：外形與排母位置和 UNO R3 相同（官方 Eagle 檔確認），借用 `arduino_uno.glb`，介面標示「3D 借用 UNO 外形」。

## 依 datasheet 程序生成（`tools/partgen/make_parts.py`）
| 檔案 | 依據 |
|---|---|
| `dht22.glb` | Aosong AM2302 規格書：15.1 × 25.0 × 7.7mm、4 腳 2.54mm；格柵與固定孔為真挖空 |
| `ssd1306_096.glb` | UG-2864HSWEG01 玻璃 26.70 × 19.26 × 1.45mm；模組 PCB 27.3 × 27.8mm（常見規格，無官方圖） |

## CircuitLoom SDK — MIT
| 檔案 | 來源 |
|---|---|
| `arduino_uno.glb` | https://github.com/SergioAscurraPerez/circuitLoom-sdk （`addons/circuitloom_sdk/models/arduino_uno.glb`） |

授權全文：`LICENSES/CircuitLoom-MIT.txt`（Copyright (c) 2026 Sergio Ascurra Perez）。
出處信心度中低：repo 0 star、2026-09 建立。模型無 Arduino 商標圖樣。
單位公尺，profile 以 `unit_scale: 1000`、`offset_mm: [34.29, 0, 26.67]` 對齊；
22 個 `PIN_*` 錨點已和 Arduino 官方 Eagle 座標逐一比對一致。

## 腳位座標
`arduino_uno_r3.json` 的腳位來自 Arduino 官方 `UNO-TH_Rev3e.brd`（CC BY-SA 4.0）。

## 自建
830 孔麵包板、杜邦線為程式化生成。
