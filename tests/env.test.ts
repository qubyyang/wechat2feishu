import { describe, expect, test } from "vitest";

import {
  assertFeishuConfig,
  getConfigStatus,
  readNumberEnv,
  WECHAT_PACING_DEFAULTS
} from "@/lib/env";

const completeConfig = {
  appId: "cli_demo",
  appSecret: "secret",
  baseUrl: "https://open.feishu.cn",
  folderToken: "fld_demo",
  historyPath: "./data/history.json",
  wechatArticleIntervalMs: WECHAT_PACING_DEFAULTS.articleIntervalMs,
  wechatListIntervalMs: WECHAT_PACING_DEFAULTS.listIntervalMs,
  wechatListPageSize: WECHAT_PACING_DEFAULTS.listPageSize,
  wechatMaxRetries: WECHAT_PACING_DEFAULTS.maxRetries,
  wechatMpCookie: "",
  wechatMpToken: "",
  wechatRetryBaseMs: WECHAT_PACING_DEFAULTS.retryBaseMs
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

describe("抓限限速参数", () => {
  test("非法或越界的数值回落到合法区间", () => {
    expect(readNumberEnv("W2F_UNSET_DEMO", 3000, 0, 60_000)).toBe(3000);
    process.env.W2F_CLAMP_DEMO = "999999";
    expect(readNumberEnv("W2F_CLAMP_DEMO", 3000, 0, 60_000)).toBe(60_000);
    process.env.W2F_CLAMP_DEMO = "-5";
    expect(readNumberEnv("W2F_CLAMP_DEMO", 3000, 0, 60_000)).toBe(0);
    delete process.env.W2F_CLAMP_DEMO;
  });

  test("默认页面大小落在微信可接受的 1..20", () => {
    expect(WECHAT_PACING_DEFAULTS.listPageSize).toBeGreaterThanOrEqual(1);
    expect(WECHAT_PACING_DEFAULTS.listPageSize).toBeLessThanOrEqual(20);
    expect(WECHAT_PACING_DEFAULTS.listIntervalMs).toBeGreaterThan(0);
  });
});
