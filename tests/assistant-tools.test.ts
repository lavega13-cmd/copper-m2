// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

// The edges of Ask Copper's tools that the module's acceptance tests don't
// spell out: the free plan adds no line, a made-up color wins over a stock
// outage, and a missing stock row is left out rather than guessed.

let rows: Record<string, unknown>[] | null = [];
vi.mock("@/lib/copper/inventory", () => ({
  readInventory: async () => structuredClone(rows),
}));

afterEach(() => {
  rows = [];
});

async function tools() {
  return import("@/lib/copper/assistant/tools");
}

describe("calculate_cost", () => {
  it("adds no line for the free plan, and counts Copper Plus once per household", async () => {
    const { calculateCost } = await tools();
    const free = calculateCost({
      products: ["copper-notes"],
      plan: "free",
      billing: "annual",
      years: 5,
    });
    expect(free.lines).toEqual([{ item: "Copper Notes", usd: 129 }]);
    expect(free.totalUsd).toBe(129);

    const household = calculateCost({
      products: ["copper-home", "copper-home", "copper-notes"],
      plan: "copper-plus",
      billing: "annual",
      years: 3,
    });
    expect(household.lines).toHaveLength(4);
    expect(household.totalUsd).toBe(149 + 149 + 129 + 3 * 79);
  });

  it("rounds monthly billing to cents", async () => {
    const { calculateCost } = await tools();
    const result = calculateCost({
      products: [],
      plan: "copper-plus",
      billing: "monthly",
      years: 3,
    });
    expect(result.totalUsd).toBe(287.64);
  });
});

describe("check_availability", () => {
  it("says a color doesn't exist even when stock can't be read", async () => {
    rows = null;
    const { checkAvailability } = await tools();
    const result = await checkAvailability({
      product: "copper-notes",
      color: "Patina Teal",
    });
    expect(result.status).toBe("not_a_color");
  });

  it("leaves out a color with no stock row instead of guessing", async () => {
    rows = [
      {
        sku: "CH-POL",
        product: "Copper Home",
        color: "Polished Copper",
        units_in_stock: 10,
        next_shipment: "2026-11-20",
      },
    ];
    const { checkAvailability } = await tools();
    expect(await checkAvailability({ product: "copper-home" })).toEqual({
      status: "ok",
      product: "Copper Home",
      colors: [
        { color: "Polished Copper", stock: "in_stock", restockDate: null },
      ],
    });
  });

  it("names no stock level when the stock list is down", async () => {
    rows = null;
    const { checkAvailability } = await tools();
    const result = await checkAvailability({ product: "copper-home" });
    expect(result.status).toBe("unavailable");
    expect(JSON.stringify(result)).not.toMatch(
      /in_stock|low_stock|backordered/,
    );
  });
});
