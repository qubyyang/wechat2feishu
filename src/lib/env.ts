import type { ExportFormat } from "./types";

/** 与 schedule.ts 共享的间隔下限，写在这里避免两个模块循环引用 */
export const SCHEDULE_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const SCHEDULE_DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

const EXPORT_FORMAT_VALUES: readonly ExportFormat[] = [
  "csv",
  "docx",
  "html",
  "markdown",
  "mhtml",
  "pdf"
];

/** 环境变量填错格式不应让整个服务起不来，静默回退到默认值并留一条告警 */
export function readExportFormatEnv(name: string, fallback: ExportFormat): ExportFormat {
  const value = process.env[name]?.trim().toLowerCase();

  if (!value) return fallback;
  if (EXPORT_FORMAT_VALUES.includes(value as ExportFormat)) return value as ExportFormat;

  console.warn(`[env] ${name}=${value} 不是受支持的导出格式，已回退为 ${fallback}。`);
  return fallback;
}

export type ServerConfig = {
  appId: string;
  appSecret: string;
  archiveIndexPath: string;
  assetIntervalMs: number;
  assetMaxBytes: number;
  baseUrl: string;
  downloadMedia: boolean;
  /** 流式导出时 ZIP 的服务端暂存目录 */
  exportJobDir: string;
  /** 暂存 ZIP 的存活时长，过期后由后续请求顺带清理 */
  exportJobTtlMs: number;
  folderToken: string;
  historyPath: string;
  /** 定时归档产出的 ZIP 落地目录 */
  scheduleArchiveDir: string;
  scheduleEnabled: boolean;
  scheduleFormat: ExportFormat;
  /** 两次归档之间的最小间隔 */
  scheduleIntervalMs: number;
  /** 单次归档最多处理的文章数，0 表示不限制 */
  scheduleLimit: number;
  scheduleStatePath: string;
  wechatArticleIntervalMs: number;
  wechatListIntervalMs: number;
  wechatListPageSize: number;
  wechatMaxRetries: number;
  wechatMpCookie: string;
  wechatMpToken: string;
  wechatRetryBaseMs: number;
};

/**
 * 微信后台对 /cgi-bin/appmsgpublish 有独立的频率配额，连续请求会直接触发
 * ret=200013（freq control）。默认值按"宁慢勿封"设定。
 */
export const WECHAT_PACING_DEFAULTS = {
  articleIntervalMs: 1200,
  assetIntervalMs: 300,
  listIntervalMs: 3000,
  listPageSize: 5,
  maxRetries: 3,
  retryBaseMs: 6000
};

/** 单个资源文件体积上限，默认 20MB */
export const ASSET_MAX_BYTES_DEFAULT = 20 * 1024 * 1024;

export function readBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();

  if (!value) return fallback;
  if (["1", "on", "true", "yes"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;

  return fallback;
}

export function readNumberEnv(
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const value = Number(process.env[name]);

  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

export function getServerConfig(): ServerConfig {
  return {
    appId: process.env.FEISHU_APP_ID ?? "",
    appSecret: process.env.FEISHU_APP_SECRET ?? "",
    archiveIndexPath: process.env.W2F_ARCHIVE_INDEX_PATH ?? "./data/archive-index.json",
    assetIntervalMs: readNumberEnv(
      "W2F_ASSET_INTERVAL_MS",
      WECHAT_PACING_DEFAULTS.assetIntervalMs,
      0,
      30_000
    ),
    assetMaxBytes: readNumberEnv(
      "W2F_ASSET_MAX_BYTES",
      ASSET_MAX_BYTES_DEFAULT,
      1024,
      200 * 1024 * 1024
    ),
    baseUrl: process.env.FEISHU_APP_BASE_URL ?? "https://open.feishu.cn",
    downloadMedia: readBooleanEnv("W2F_DOWNLOAD_MEDIA", false),
    exportJobDir: process.env.W2F_EXPORT_JOB_DIR ?? "./data/export-jobs",
    exportJobTtlMs: readNumberEnv(
      "W2F_EXPORT_JOB_TTL_MS",
      30 * 60 * 1000,
      60_000,
      24 * 60 * 60 * 1000
    ),
    folderToken: process.env.FEISHU_FOLDER_TOKEN ?? "",
    historyPath: process.env.W2F_HISTORY_PATH ?? "./data/history.json",
    scheduleArchiveDir: process.env.W2F_SCHEDULE_ARCHIVE_DIR ?? "./data/archives",
    scheduleEnabled: readBooleanEnv("W2F_SCHEDULE_ENABLED", false),
    scheduleFormat: readExportFormatEnv("W2F_SCHEDULE_FORMAT", "markdown"),
    scheduleIntervalMs: readNumberEnv(
      "W2F_SCHEDULE_INTERVAL_MS",
      SCHEDULE_DEFAULT_INTERVAL_MS,
      SCHEDULE_MIN_INTERVAL_MS,
      30 * 24 * 60 * 60 * 1000
    ),
    scheduleLimit: readNumberEnv("W2F_SCHEDULE_LIMIT", 0, 0, 1000),
    scheduleStatePath: process.env.W2F_SCHEDULE_STATE_PATH ?? "./data/schedule-state.json",
    wechatArticleIntervalMs: readNumberEnv(
      "W2F_WECHAT_ARTICLE_INTERVAL_MS",
      WECHAT_PACING_DEFAULTS.articleIntervalMs,
      0,
      30_000
    ),
    wechatListIntervalMs: readNumberEnv(
      "W2F_WECHAT_LIST_INTERVAL_MS",
      WECHAT_PACING_DEFAULTS.listIntervalMs,
      0,
      60_000
    ),
    wechatListPageSize: readNumberEnv(
      "W2F_WECHAT_LIST_PAGE_SIZE",
      WECHAT_PACING_DEFAULTS.listPageSize,
      1,
      20
    ),
    wechatMaxRetries: readNumberEnv("W2F_WECHAT_MAX_RETRIES", WECHAT_PACING_DEFAULTS.maxRetries, 0, 6),
    wechatMpCookie: process.env.W2F_WECHAT_MP_COOKIE ?? "",
    wechatMpToken: process.env.W2F_WECHAT_MP_TOKEN ?? "",
    wechatRetryBaseMs: readNumberEnv(
      "W2F_WECHAT_RETRY_BASE_MS",
      WECHAT_PACING_DEFAULTS.retryBaseMs,
      0,
      60_000
    )
  };
}

export function getConfigStatus(config = getServerConfig()) {
  return {
    appId: Boolean(config.appId),
    appSecret: Boolean(config.appSecret),
    baseUrl: config.baseUrl,
    folderToken: Boolean(config.folderToken),
    ready: Boolean(config.appId && config.appSecret && config.folderToken),
    wechatBatchReady: Boolean(config.wechatMpCookie && config.wechatMpToken),
    wechatMpCookie: Boolean(config.wechatMpCookie),
    wechatMpToken: Boolean(config.wechatMpToken)
  };
}

export function assertFeishuConfig(config = getServerConfig()): ServerConfig {
  const missing = [
    !config.appId ? "FEISHU_APP_ID" : undefined,
    !config.appSecret ? "FEISHU_APP_SECRET" : undefined,
    !config.folderToken ? "FEISHU_FOLDER_TOKEN" : undefined
  ].filter(Boolean);

  if (missing.length) {
    throw new Error(`请先在 .env 中填写 ${missing.join("、")}。`);
  }

  return config;
}

export function assertWechatBatchConfig(config = getServerConfig()): ServerConfig {
  const missing = [
    !config.wechatMpToken ? "W2F_WECHAT_MP_TOKEN" : undefined,
    !config.wechatMpCookie ? "W2F_WECHAT_MP_COOKIE" : undefined
  ].filter(Boolean);

  if (missing.length) {
    throw new Error(`请先在 .env 中填写 ${missing.join("、")}。`);
  }

  return config;
}
