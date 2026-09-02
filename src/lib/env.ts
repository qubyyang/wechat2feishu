export type ServerConfig = {
  appId: string;
  appSecret: string;
  baseUrl: string;
  folderToken: string;
  historyPath: string;
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
  listIntervalMs: 3000,
  listPageSize: 5,
  maxRetries: 3,
  retryBaseMs: 6000
};

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
    baseUrl: process.env.FEISHU_APP_BASE_URL ?? "https://open.feishu.cn",
    folderToken: process.env.FEISHU_FOLDER_TOKEN ?? "",
    historyPath: process.env.W2F_HISTORY_PATH ?? "./data/history.json",
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
