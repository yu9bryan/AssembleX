import { describe, it, expect } from "vitest";
import {
  BREADBOARD_830, buildBreadboard, indexHoles, nearestHole, PITCH_MM,
} from "../src/breadboard.js";

const holes = buildBreadboard();
const idx = indexHoles(holes);

describe("830 孔麵包板拓樸", () => {
  it("孔數正好 830", () => {
    expect(holes.length).toBe(830);
    expect(holes.filter(h => h.kind === "main").length).toBe(630);
    expect(holes.filter(h => h.kind === "rail").length).toBe(200);
  });

  it("A5–E5 同一導通群組", () => {
    const g = ["A5", "B5", "C5", "D5", "E5"].map(id => idx.get(id)!.tie_group);
    expect(new Set(g).size).toBe(1);
  });

  it("F5–J5 是另一個獨立群組", () => {
    const lower = idx.get("E5")!.tie_group;
    const upper = ["F5", "G5", "H5", "I5", "J5"].map(id => idx.get(id)!.tie_group);
    expect(new Set(upper).size).toBe(1);
    expect(upper[0]).not.toBe(lower);   // 中央溝必須隔開上下半部
  });

  it("不同欄不互通", () => {
    expect(idx.get("A5")!.tie_group).not.toBe(idx.get("A6")!.tie_group);
  });

  it("孔距是 2.54 mm", () => {
    const a = idx.get("A5")!.position_mm, b = idx.get("A6")!.position_mm;
    expect(b[0] - a[0]).toBeCloseTo(PITCH_MM, 6);
    const c = idx.get("B5")!.position_mm;
    expect(c[2] - a[2]).toBeCloseTo(PITCH_MM, 6);
  });

  it("中央溝寬 7.62 mm", () => {
    expect(idx.get("F1")!.position_mm[2] - idx.get("E1")!.position_mm[2]).toBeCloseTo(7.62, 6);
  });

  it("電源軌中間斷開，分成兩段", () => {
    expect(idx.get("TOP+1")!.tie_group).toBe(idx.get("TOP+25")!.tie_group);
    expect(idx.get("TOP+25")!.tie_group).not.toBe(idx.get("TOP+26")!.tie_group);
    expect(idx.get("TOP+26")!.tie_group).toBe(idx.get("TOP+50")!.tie_group);
  });

  it("+ 軌和 − 軌不互通", () => {
    expect(idx.get("TOP+1")!.tie_group).not.toBe(idx.get("TOP-1")!.tie_group);
  });

  it("所有孔都落在板子範圍內", () => {
    const [W, , D] = BREADBOARD_830.size_mm;
    for (const h of holes) {
      expect(h.position_mm[0]).toBeGreaterThan(0);
      expect(h.position_mm[0]).toBeLessThan(W);
      expect(h.position_mm[2]).toBeGreaterThan(0);
      expect(h.position_mm[2]).toBeLessThan(D);
    }
  });

  it("吸附找得到最近的孔，太遠就是 null", () => {
    const t = idx.get("C20")!.position_mm;
    expect(nearestHole(holes, t[0] + 0.4, t[2] - 0.3)?.id).toBe("C20");
    expect(nearestHole(holes, t[0] + 1.27, t[2] + 1.27)).toBeNull();
  });
});
