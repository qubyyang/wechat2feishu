import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  NothingToExportError,
  runAccountExport,
  type AccountExportOutcome
} from "./account-export";
import { getServerConfig } from "./env";
import { safeDocumentTitle } from "./safe";
import type {
  ExportFormat,
  ScheduleAccountState,
  ScheduleRunSummary,
  ScheduleState
} from "./types";

const SCHEDULE_STATE_VERSION = 1;

/**
 * 定时增量归档。
 *
 * 设计取舍：**不内置 cron 守护进程**。Next.js 的 route handler 在 serverless 与
 * 常驻部署下生命周期完全不同，进程内 setInterval 会随实例回收静默消失，且多实例
 * 部署时会并发打微信接口——那是 `规矩文档.md` 第 1 条明令禁止的。
 * 因此这里只提供幂等的 `tick()`：由外部 cron / 系统定时器按分钟粒度调用，
 * 是否真正执行由「上次运行时间 + 间隔」判定。调用得再密也不会超频。
 */
export type ScheduleConfig = {
  accountIds: string[];
  archiveDir: string;
  enabled: boolean;
  format: ExportFormat;
  intervalMs: number;
  limit?: number;
  statePath: string;
};

/** 最小间隔 5 分钟：再密就没有「增量」意义，只是白烧频控配额 */
export { SCHEDULE_DEFAULT_INTERVAL_MS, SCHEDULE_MIN_INTERVAL_MS } from "./env";

/** 解析逗号 / 空白分隔的账号列表，去重且保持书写顺序 */
export function parseScheduleAccountIds(raw: string | undefined): string[] {
  if (!raw) return [];

  const seen = new Set<string>();
  const result: string[] = [];

  for (const piece of raw.split(/[\s,;，、]+/)) {
    const id = piece.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }

  return result;
}

export function normalizeScheduleState(value: unknown): ScheduleState {
  const root = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const accountsRaw =
    root.accounts && typeof root.accounts === "object"
      ? (root.accounts as Record<string, unknown>)
      : {};
  const accounts: Record<string, ScheduleAccountState> = {};

  for (const [accountId, entryRaw] of Object.entries(accountsRaw)) {
    const entry =
      entryRaw && typeof entryRaw === "object" ? (entryRaw as Record<string, unknown>) : {};
    const status = entry.lastStatus;

    accounts[accountId] = {
      accountId,
      archiveFilename:
        typeof entry.archiveFilename === "string" ? entry.archiveFilename : undefined,
      consecutiveFailures:
        typeof entry.consecutiveFailures === "number" && entry.consecutiveFailures >= 0
          ? Math.floor(entry.consecutiveFailures)
          : 0,
      error: typeof entry.error === "string" ? entry.error : undefined,
      lastRunAt: typeof entry.lastRunAt === "string" ? entry.lastRunAt : undefined,
      lastStatus:
        status === "failed" || status === "skipped" || status === "success"
          ? status
          : undefined,
      successCount: typeof entry.successCount === "number" ? entry.successCount : undefined
    };
  }

  return {
    accounts,
    lastTickAt: typeof root.lastTickAt === "string" ? root.lastTickAt : undefined,
    version: SCHEDULE_STATE_VERSION
  };
}

export class ScheduleStateStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  async read(): Promise<ScheduleState> {
    try {
      return normalizeScheduleState(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // 状态损坏或缺失都退化成「从未运行」，不阻断调度
      if (code === "ENOENT" || error instanceof SyntaxError) {
        return { accounts: {}, version: SCHEDULE_STATE_VERSION };
      }
      throw error;
    }
  }

  async write(state: ScheduleState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

export function getScheduleConfig(): ScheduleConfig {
  const config = getServerConfig();

  return {
    accountIds: parseScheduleAccountIds(process.env.W2F_SCHEDULE_ACCOUNTS),
    archiveDir: config.scheduleArchiveDir,
    enabled: config.scheduleEnabled,
    format: config.scheduleFormat,
    intervalMs: config.scheduleIntervalMs,
    limit: config.scheduleLimit > 0 ? config.scheduleLimit : undefined,
    statePath: config.scheduleStatePath
  };
}

/** 到期判定：从未运行过即到期；否则看距上次运行是否已满一个间隔 */
export function isAccountDue(options: {
  intervalMs: number;
  now: number;
  state?: ScheduleAccountState;
}): boolean {
  const last = options.state?.lastRunAt;
  if (!last) return true;

  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return true;

  return options.now - lastMs >= options.intervalMs;
}

export function scheduleArchiveFilename(accountId: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${safeDocumentTitle(accountId)}-${stamp}.zip`;
}

let running: Promise<ScheduleRunSummary[]> | undefined;

export type ScheduleTickOptions = {
  config?: ScheduleConfig;
  /** 忽略间隔限制立即执行指定账号（不传则全部） */
  force?: boolean;
  now?: Date;
  onlyAccountId?: string;
  /** 测试注入点；默认走真实导出内核 */
  runExport?: (options: {
    accountId: string;
    format: ExportFormat;
    limit?: number;
  }) => Promise<AccountExportOutcome>;
};

/**
 * 执行一轮调度。**串行**遍历账号——并发会把微信频控配额瞬间打爆，
 * 且 `wechat.ts` 的限速器是按调用序列排队的，并发调用等于绕过它。
 * 同一进程内的重入被 `running` 挡住，返回同一个 Promise。
 */
export function runScheduleTick(
  options: ScheduleTickOptions = {}
): Promise<ScheduleRunSummary[]> {
  if (running) return running;

  running = executeTick(options).finally(() => {
    running = undefined;
  });

  return running;
}

async function executeTick(options: ScheduleTickOptions): Promise<ScheduleRunSummary[]> {
  const config = options.config ?? getScheduleConfig();
  const now = options.now ?? new Date();
  const store = new ScheduleStateStore(config.statePath);
  const state = await store.read();
  const runExport = options.runExport ?? defaultRunExport;
  const summaries: ScheduleRunSummary[] = [];

  const targets = options.onlyAccountId
    ? config.accountIds.filter((id) => id === options.onlyAccountId)
    : config.accountIds;

  if (options.onlyAccountId && !targets.length) {
    throw new Error(`账号 ${options.onlyAccountId} 不在定时归档列表中。`);
  }

  if (!config.enabled && !options.force) {
    state.lastTickAt = now.toISOString();
    await store.write(state);
    return targets.map((accountId) => ({
      accountId,
      reason: "定时归档未启用",
      status: "skipped" as const
    }));
  }

  for (const accountId of targets) {
    const previous = state.accounts[accountId];

    if (!options.force && !isAccountDue({ intervalMs: config.intervalMs, now: now.getTime(), state: previous })) {
      summaries.push({ accountId, reason: "距上次归档未满间隔", status: "skipped" });
      continue;
    }

    try {
      const outcome = await runExport({
        accountId,
        format: config.format,
        limit: config.limit
      });
      const filename = scheduleArchiveFilename(accountId, now);

      await mkdir(resolve(config.archiveDir), { recursive: true });
      await writeFile(join(resolve(config.archiveDir), filename), outcome.zip);

      state.accounts[accountId] = {
        accountId,
        archiveFilename: filename,
        consecutiveFailures: 0,
        lastRunAt: now.toISOString(),
        lastStatus: "success",
        successCount: outcome.successCount
      };
      summaries.push({
        accountId,
        archiveFilename: filename,
        status: "success",
        successCount: outcome.successCount
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "定时归档失败";

      // 「没有新增内容」是预期结果：照常推进 lastRunAt，不计失败、不产出空包
      if (error instanceof NothingToExportError) {
        state.accounts[accountId] = {
          accountId,
          archiveFilename: previous?.archiveFilename,
          consecutiveFailures: 0,
          lastRunAt: now.toISOString(),
          lastStatus: "skipped",
          successCount: 0
        };
        summaries.push({ accountId, reason: message, status: "skipped" });
        continue;
      }

      // 失败也推进 lastRunAt：否则下一次 tick 会立刻重试，
      // 而失败最常见的原因正是频控，密集重试只会让惩罚更久。
      state.accounts[accountId] = {
        accountId,
        archiveFilename: previous?.archiveFilename,
        consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
        error: message,
        lastRunAt: now.toISOString(),
        lastStatus: "failed"
      };
      summaries.push({ accountId, error: message, status: "failed" });
    }
  }

  state.lastTickAt = now.toISOString();
  await store.write(state);

  return summaries;
}

function defaultRunExport(options: {
  accountId: string;
  format: ExportFormat;
  limit?: number;
}): Promise<AccountExportOutcome> {
  return runAccountExport({
    accountId: options.accountId,
    format: options.format,
    incremental: true,
    limit: options.limit
  });
}
