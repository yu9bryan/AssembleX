import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CircuitIR } from "../src/circuit-ir.js";
import { ComponentProfile } from "../src/component-profile.js";
import { buildBreadboard, BREADBOARD_830 } from "../src/breadboard.js";
import { routeWires, endpointPosition, segmentDistance, DEFAULT_ROUTE_OPTIONS, countPlanCrossings, findWireCollisions } from "../src/routing.js";

const APP = join(__dirname, "../../../apps/desktop/src/data");
const profiles = new Map(
  readdirSync(join(APP, "components")).filter((f) => f.endsWith(".json"))
    .map((f) => ComponentProfile.parse(JSON.parse(readFileSync(join(APP, "components", f), "utf8"))))
    .map((p) => [p.component_id, p] as const));
const holes = buildBreadboard();
const holeIndex = new Map(holes.map((h) => [h.id, h]));
const S = BREADBOARD_830.surface_y_mm;

for (const file of readdirSync(join(APP, "examples")).filter((f) => f.endsWith(".circuit.json"))) {
  const ir = CircuitIR.parse(JSON.parse(readFileSync(join(APP, "examples", file), "utf8")));
  const routes = routeWires(ir, profiles, holes);

  describe(`佈線：${file}`, () => {
    it("從上往下看零交叉（內建範例是展示用的主視覺，不能有任何兩條線疊在一起）", () => {
      expect(countPlanCrossings(routes)).toBe(0);
      expect(findWireCollisions(routes)).toEqual([]);
    });

    it("每條線都有路徑", () => {
      expect(routes.size).toBe(ir.physical.wires.length);
    });

    it("端點精準落在孔位或腳位上", () => {
      for (const w of ir.physical.wires) {
        const p = routes.get(w.id)!;
        const a = endpointPosition(w.from, ir, profiles, holeIndex)!;
        const b = endpointPosition(w.to, ir, profiles, holeIndex)!;
        const ends = [p[0], p[p.length - 1]];
        for (const e of [a, b]) {
          expect(ends.some((q) => Math.hypot(q[0] - e[0], q[1] - e[1], q[2] - e[2]) < 1e-6)).toBe(true);
        }
      }
    });

    it("板內跳線全部是直角（每段只沿一個軸）", () => {
      for (const w of ir.physical.wires) {
        if (w.from.kind !== "hole" || w.to.kind !== "hole") continue;
        const p = routes.get(w.id)!;
        for (let i = 0; i < p.length - 1; i++) {
          const moving = [0, 1, 2].filter((k) => Math.abs(p[i + 1][k] - p[i][k]) > 1e-6);
          expect(moving.length).toBeLessThanOrEqual(1);
        }
      }
    });

    it("板內跳線不會穿進板面（中間點都在板面之上）", () => {
      for (const w of ir.physical.wires) {
        if (w.from.kind !== "hole" || w.to.kind !== "hole") continue;
        const p = routes.get(w.id)!;
        for (const q of p.slice(1, -1)) expect(q[1]).toBeGreaterThan(S + 0.5);
      }
    });

    // 包含插進孔的那一段垂直線：之前漏掉它，結果別條線可以從插頭正上方壓過去（使用者實際看到的交叉）
    it("不同導線的所有段落（含插孔的垂直段）彼此不相交（距離 ≥ 線徑＋間隙）", () => {
      const minSep = DEFAULT_ROUTE_OPTIONS.wireRadius * 2 + DEFAULT_ROUTE_OPTIONS.gap - 1e-6;
      const segs = [...routes.entries()].map(([id, p]) => ({
        id,
        s: p.slice(0, -1).map((a, i) => [a, p[i + 1]] as const),
      }));
      for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
        for (const [a, b] of segs[i].s) for (const [c, d] of segs[j].s) {
          expect(segmentDistance(a, b, c, d), `${segs[i].id} × ${segs[j].id}`).toBeGreaterThanOrEqual(minSep);
        }
      }
    });
  });
}
