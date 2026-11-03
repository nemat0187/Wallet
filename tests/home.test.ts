import { describe, expect, it } from "vitest";
import { defaultHomeLayout, moveInColumn, resolveHomeLayout, type HomeItem } from "../shared/home";

describe("resolveHomeLayout", () => {
  it("uses the default layout when nothing is saved", () => {
    expect(resolveHomeLayout(null, []).map((i) => i.id)).toEqual(["hero", "attention", "where", "latest", "cards", "budgets", "coach", "places"]);
  });

  it("keeps the saved order and brings back missing blocks", () => {
    const saved: HomeItem[] = [
      { id: "budgets", col: "main" },
      { id: "hero", col: "main", hidden: true },
    ];
    const out = resolveHomeLayout(saved, []);
    expect(out.slice(0, 2).map((i) => i.id)).toEqual(["budgets", "hero"]);
    expect(out[1].hidden).toBe(true);
    expect(out).toHaveLength(8);
  });

  it("adds pinned dashboards full width and drops unpinned or unknown ones", () => {
    const saved: HomeItem[] = [...defaultHomeLayout(), { id: "dash:3", col: "main" }, { id: "dash:9", col: "main" }, { id: "nonsense", col: "main" }];
    const out = resolveHomeLayout(saved, [3, 4]);
    expect(out.find((i) => i.id === "dash:3")?.col).toBe("main");
    expect(out.find((i) => i.id === "dash:4")?.col).toBe("wide");
    expect(out.some((i) => i.id === "dash:9" || i.id === "nonsense")).toBe(false);
  });

  it("keeps widgets made on Home only when they carry their definition", () => {
    const widget = { id: "abc" } as never;
    const out = resolveHomeLayout([...defaultHomeLayout(), { id: "w:abc", col: "aside", widget }, { id: "w:gone", col: "aside" }], []);
    expect(out.some((i) => i.id === "w:abc")).toBe(true);
    expect(out.some((i) => i.id === "w:gone")).toBe(false);
  });
});

describe("moveInColumn", () => {
  it("swaps with the neighbour in the same column only", () => {
    const items = defaultHomeLayout(); // main: hero, attention, where, latest | aside: cards, budgets, coach, places
    expect(moveInColumn(items, "cards", 1).map((i) => i.id).slice(4, 6)).toEqual(["budgets", "cards"]);
    expect(moveInColumn(items, "latest", 1)).toEqual(items); // last of its column
    expect(moveInColumn(items, "cards", -1)).toEqual(items); // first of its column
  });
});
