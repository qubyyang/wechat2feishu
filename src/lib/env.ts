export type ServerConfig = {
  appId: string;
  appSecret: string;
  baseUrl: string;
  folderToken: string;
  historyPath: string;
  wechatMpCookie: string;
  wechatMpToken: string;
};

export function getServerConfig(): ServerConfig {
  return {
    appId: process.env.FEISHU_APP_ID ?? "",
    appSecret: process.env.FEISHU_APP_SECRET ?? "",
    baseUrl: process.env.FEISHU_APP_BASE_URL ?? "https://open.feishu.cn",
    folderToken: process.env.FEISHU_FOLDER_TOKEN ?? "",
    historyPath: process.env.W2F_HISTORY_PATH ?? "./data/history.json",
    wechatMpCookie: process.env.W2F_WECHAT_MP_COOKIE ?? "",
    wechatMpToken: process.env.W2F_WECHAT_MP_TOKEN ?? ""
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
