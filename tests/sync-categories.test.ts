import { describe, expect, it } from "vitest";
import { SYNC_TABLES } from "../src/shared/sync-schema";
import {
  SYNC_CATEGORIES,
  categorisedTables,
  uncategorisedTables,
} from "../src/shared/sync-categories";

/**
 * Settings → Cloud sync tells the doctor exactly what leaves the device, so
 * every syncable table must be described there. A new table added to the sync
 * schema without a category would silently become invisible in that list.
 */
describe("sync categories", () => {
  const allNames = SYNC_TABLES.map((t) => t.name);

  it("describes every syncable table", () => {
    expect(uncategorisedTables()).toEqual([]);
    expect([...categorisedTables()].sort()).toEqual([...allNames].sort());
  });

  it("does not repeat a table in two categories", () => {
    const seen = SYNC_CATEGORIES.flatMap((c) => c.tables);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("does not name tables outside the sync schema", () => {
    const known = new Set(allNames);
    for (const category of SYNC_CATEGORIES) {
      for (const table of category.tables) {
        expect(known.has(table), `${category.label} references unknown table ${table}`).toBe(true);
      }
    }
  });

  it("has a description for every category", () => {
    for (const category of SYNC_CATEGORIES) {
      expect(category.label.trim().length).toBeGreaterThan(0);
      expect(category.description.trim().length).toBeGreaterThan(0);
      expect(category.tables.length).toBeGreaterThan(0);
    }
  });
});
