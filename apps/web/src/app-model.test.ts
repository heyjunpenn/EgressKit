import { describe, expect, it } from "vitest";
import { navigation } from "./app-model";

describe("console navigation", () => {
  it("contains every authenticated product surface", () => {
    expect(navigation.map((item) => item.id)).toEqual([
      "overview",
      "subscriptions",
      "proxies",
      "sessions",
      "playground",
      "settings",
      "docs",
    ]);
  });

  it("uses browser paths under the app namespace", () => {
    expect(navigation.map((item) => item.path)).toEqual([
      "/app",
      "/app/subscriptions",
      "/app/proxies",
      "/app/sessions",
      "/app/playground",
      "/app/settings",
      "/app/docs",
    ]);
  });
});
