import { describe, expect, test } from "vitest";

import { assertFeishuConfig, getConfigStatus } from "@/lib/env";

const completeConfig = {
  appId: "cli_demo",
  appSecret: "secret",
  baseUrl: "https://open.feishu.cn",
  folderToken: "fld_demo",
  historyPath: "./data/history.json"
};

describe("Feishu config status", () => {
  test("requires the folder token before Feishu transfer is ready", () => {
    expect(
      getConfigStatus({
        ...completeConfig,
        folderToken: ""
      }).ready
    ).toBe(false);
    expect(getConfigStatus(completeConfig).ready).toBe(true);
  });

  test("reports all missing Feishu variables before transfer", () => {
    expect(() =>
      assertFeishuConfig({
        ...completeConfig,
        appId: "",
        appSecret: "",
        folderToken: ""
      })
    ).toThrow("FEISHU_APP_ID、FEISHU_APP_SECRET、FEISHU_FOLDER_TOKEN");
  });
});
