export type ServerConfig = {
  appId: string;
  appSecret: string;
  baseUrl: string;
  folderToken: string;
  historyPath: string;
};

export function getServerConfig(): ServerConfig {
  return {
    appId: process.env.FEISHU_APP_ID ?? "",
    appSecret: process.env.FEISHU_APP_SECRET ?? "",
    baseUrl: process.env.FEISHU_APP_BASE_URL ?? "https://open.feishu.cn",
    folderToken: process.env.FEISHU_FOLDER_TOKEN ?? "",
    historyPath: process.env.W2F_HISTORY_PATH ?? "./data/history.json"
  };
}

export function getConfigStatus(config = getServerConfig()) {
  return {
    appId: Boolean(config.appId),
    appSecret: Boolean(config.appSecret),
    baseUrl: config.baseUrl,
    folderToken: Boolean(config.folderToken),
    ready: Boolean(config.appId && config.appSecret)
  };
}

export function assertFeishuConfig(config = getServerConfig()): ServerConfig {
  const missing = [
    !config.appId ? "FEISHU_APP_ID" : undefined,
    !config.appSecret ? "FEISHU_APP_SECRET" : undefined
  ].filter(Boolean);

  if (missing.length) {
    throw new Error(`请先在 .env 中填写 ${missing.join("、")}。`);
  }

  return config;
}
