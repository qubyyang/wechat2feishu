import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { NothingToExportError, type AccountExportOutcome } from "@/lib/account-export";
import {
  isAccountDue,
  normalizeScheduleState,
  parseScheduleAccountIds,
  runScheduleTick,
  scheduleArchiveFilename,
  ScheduleStateStore,
  type ScheduleConfig
} from "@/lib/schedule";
import type { ScheduleState } from "@/lib/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function makeConfig(overrides: Partial<ScheduleConfig> = {}): Promise<ScheduleConfig> {
  const dir = await mkdtemp(join(tmpdir(), "w2f-schedule-"));

  return {
    accountIds: ["MzA1", "MzA2"],
    archiveDir: join(dir, "archives"),
    enabled: true,
    format: "markdown",
    intervalMs: 24 * 60 * 60 * 1000,
    statePath: join(dir, "schedule-state.json"),
    ...overrides
  };
}

function outcome(successCount: number): AccountExportOutcome {
  return {
    assetCount: 0,
    filename: "demo.zip",
    resumedCount: 0,
    skippedCount: 0,
    successCount,
    warnings: [],
    zip: Buffer.from("PK-fake-zip")
  };
}

describe("账号列表解析", () => {
  test("支持逗号、中文顿号与空白混用，并去重保序", () => {
    expect(parseScheduleAccountIds("MzA1, MzA2、MzA1  MzA3")).toEqual([
      "MzA1",
      "MzA2",
      "MzA3"
    ]);
  });

  test("未配置时返回空数组而不是抛错", () => {
    expect(parseScheduleAccountIds(undefined)).toEqual([]);
    expect(parseScheduleAccountIds("  ")).toEqual([]);
  });
});

describe("到期判定", () => {
  const intervalMs = 60 * 60 * 1000;
  const now = Date.parse("2026-09-05T12:00:00.000Z");

  test("从未运行过视为到期", () => {
    expect(isAccountDue({ intervalMs, now })).toBe(true);
  });

  test("未满间隔不执行，满一个间隔才执行", () => {
    const recent = {
      accountId: "MzA1",
      consecutiveFailures: 0,
      lastRunAt: "2026-09-05T11:30:00.000Z"
    };
    expect(isAccountDue({ intervalMs, now, state: recent })).toBe(false);

    const stale = { ...recent, lastRunAt: "2026-09-05T10:59:00.000Z" };
    expect(isAccountDue({ intervalMs, now, state: stale })).toBe(true);
  });

  test("时间戳损坏时按到期处理，避免账号被永久卡住", () => {
    expect(
      isAccountDue({
        intervalMs,
        now,
        state: { accountId: "MzA1", consecutiveFailures: 0, lastRunAt: "not-a-date" }
      })
    ).toBe(true);
  });
});

describe("状态文件", () => {
  test("损坏的 JSON 退化为空状态而不是抛错", async () => {
    const dir = await mkdtemp(join(tmpdir(), "w2f-schedule-state-"));
    const file = join(dir, "state.json");
    await writeFile(file, "{ broken", "utf8");

    const state = await new ScheduleStateStore(file).read();
    expect(state.accounts).toEqual({});
  });

  test("归一化会补齐缺失字段并丢弃非法状态值", () => {
    const state = normalizeScheduleState({
      accounts: { MzA1: { consecutiveFailures: -3, lastStatus: "weird" } }
    });
    expect(state.accounts.MzA1).toMatchObject({
      accountId: "MzA1",
      consecutiveFailures: 0,
      lastStatus: undefined
    });
  });
});

describe("调度执行", () => {
  test("串行执行到期账号并把 ZIP 落到归档目录", async () => {
    const config = await makeConfig();
    const order: string[] = [];
    let concurrent = 0;

    const results = await runScheduleTick({
      config,
      now: new Date("2026-09-05T12:00:00.000Z"),
      runExport: async ({ accountId }) => {
        concurrent += 1;
        // 并发会绕过 wechat.ts 的限速队列，直接把频控配额打爆
        expect(concurrent).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 1));
        order.push(accountId);
        concurrent -= 1;
        return outcome(3);
      }
    });

    expect(order).toEqual(["MzA1", "MzA2"]);
    expect(results.every((item) => item.status === "success")).toBe(true);

    const files = await readdir(config.archiveDir);
    expect(files).toHaveLength(2);
    expect(files.every((name) => name.endsWith(".zip"))).toBe(true);

    const state = JSON.parse(await readFile(config.statePath, "utf8")) as ScheduleState;
    expect(state.accounts.MzA1.lastStatus).toBe("success");
    expect(state.accounts.MzA1.successCount).toBe(3);
    expect(state.lastTickAt).toBe("2026-09-05T12:00:00.000Z");
  });

  test("未到期的账号被跳过且不触发导出", async () => {
    const config = await makeConfig({ accountIds: ["MzA1"] });
    const now = new Date("2026-09-05T12:00:00.000Z");
    const runExport = vi.fn(async () => outcome(1));

    await runScheduleTick({ config, now, runExport });
    const second = await runScheduleTick({
      config,
      now: new Date("2026-09-05T13:00:00.000Z"),
      runExport
    });

    expect(runExport).toHaveBeenCalledTimes(1);
    expect(second[0]).toMatchObject({ status: "skipped" });
  });

  test("force 忽略间隔限制", async () => {
    const config = await makeConfig({ accountIds: ["MzA1"] });
    const runExport = vi.fn(async () => outcome(1));

    await runScheduleTick({ config, now: new Date("2026-09-05T12:00:00.000Z"), runExport });
    await runScheduleTick({
      config,
      force: true,
      now: new Date("2026-09-05T12:01:00.000Z"),
      runExport
    });

    expect(runExport).toHaveBeenCalledTimes(2);
  });

  test("没有新增内容记为 skipped，不计失败也不产出空包", async () => {
    const config = await makeConfig({ accountIds: ["MzA1"] });

    const results = await runScheduleTick({
      config,
      now: new Date("2026-09-05T12:00:00.000Z"),
      runExport: async () => {
        throw new NothingToExportError("都已归档过");
      }
    });

    expect(results[0]).toMatchObject({ status: "skipped" });
    await expect(readdir(config.archiveDir)).rejects.toThrow();

    const state = await new ScheduleStateStore(config.statePath).read();
    expect(state.accounts.MzA1.consecutiveFailures).toBe(0);
    expect(state.accounts.MzA1.lastRunAt).toBe("2026-09-05T12:00:00.000Z");
  });

  test("失败会累计次数，且同样推进 lastRunAt 以免密集重试踩频控", async () => {
    const config = await makeConfig({ accountIds: ["MzA1"] });
    const now = new Date("2026-09-05T12:00:00.000Z");
    const runExport = async () => {
      throw new Error("freq control");
    };

    await runScheduleTick({ config, now, runExport });
    await runScheduleTick({ config, force: true, now, runExport });

    const state = await new ScheduleStateStore(config.statePath).read();
    expect(state.accounts.MzA1).toMatchObject({
      consecutiveFailures: 2,
      error: "freq control",
      lastRunAt: "2026-09-05T12:00:00.000Z",
      lastStatus: "failed"
    });
  });

  test("未启用时全部跳过，但 force 仍可手动触发", async () => {
    const config = await makeConfig({ accountIds: ["MzA1"], enabled: false });
    const runExport = vi.fn(async () => outcome(1));

    const skipped = await runScheduleTick({ config, runExport });
    expect(skipped[0]).toMatchObject({ reason: "定时归档未启用", status: "skipped" });
    expect(runExport).not.toHaveBeenCalled();

    await runScheduleTick({ config, force: true, runExport });
    expect(runExport).toHaveBeenCalledTimes(1);
  });

  test("指定不在计划内的账号直接报错", async () => {
    const config = await makeConfig();

    await expect(
      runScheduleTick({ config, force: true, onlyAccountId: "MzZZ" })
    ).rejects.toThrow("不在定时归档列表中");
  });
});

describe("归档文件名", () => {
  test("含时间戳且不含非法路径字符", () => {
    const name = scheduleArchiveFilename("MzA1/../etc", new Date("2026-09-05T12:00:00.000Z"));
    expect(name).not.toContain("/");
    expect(name).toContain("2026-09-05T12-00-00");
    expect(name.endsWith(".zip")).toBe(true);
  });
});
