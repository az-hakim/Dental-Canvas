import { describe, expect, it } from "vitest";
import {
  ACCOUNT_MODE_KEY,
  parseAccountMode,
  readAccountMode,
  shouldOfferAccountStep,
  writeAccountMode,
  type KeyValueStore,
} from "../src/client/lib/account-mode";

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

describe("account mode preference", () => {
  it("defaults to unset and only accepts known values", () => {
    expect(parseAccountMode(null)).toBe("unset");
    expect(parseAccountMode("nonsense")).toBe("unset");
    expect(parseAccountMode("offline")).toBe("offline");
    expect(parseAccountMode("cloud")).toBe("cloud");
  });

  it("persists Skip so onboarding never asks again", () => {
    const store = memoryStore();
    expect(readAccountMode(store)).toBe("unset");
    writeAccountMode("offline", store);
    expect(store.data.get(ACCOUNT_MODE_KEY)).toBe("offline");
    expect(readAccountMode(store)).toBe("offline");
    expect(shouldOfferAccountStep(readAccountMode(store), true)).toBe(false);
  });

  it("offers the step only when cloud is configured and unanswered", () => {
    expect(shouldOfferAccountStep("unset", true)).toBe(true);
    expect(shouldOfferAccountStep("unset", false)).toBe(false);
    expect(shouldOfferAccountStep("cloud", true)).toBe(false);
    expect(shouldOfferAccountStep("offline", true)).toBe(false);
  });

  it("survives a storage that throws (private mode)", () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readAccountMode(broken)).toBe("unset");
    expect(() => writeAccountMode("offline", broken)).not.toThrow();
  });
});
