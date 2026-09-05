import { existsSync } from "node:fs";

/**
 * 浏览器启动的唯一入口。
 *
 * 安全验证页回退（wechat.ts）与 PDF 导出（renderers.ts）都要拉起 Chromium，
 * 抽到这里避免两处各写一套解析与兜底逻辑。
 */

export type PlaywrightPage = {
  content(): Promise<string>;
  goto(
    url: string,
    options: { timeout: number; waitUntil: "domcontentloaded" }
  ): Promise<unknown>;
  pdf(options: {
    format: string;
    margin: { bottom: string; left: string; right: string; top: string };
    printBackground: boolean;
  }): Promise<Buffer | Uint8Array>;
  setContent(
    html: string,
    options: { timeout: number; waitUntil: "networkidle" }
  ): Promise<unknown>;
  waitForTimeout(timeout: number): Promise<void>;
};

export type PlaywrightBrowser = {
  close(): Promise<void>;
  newPage(options?: { userAgent?: string }): Promise<PlaywrightPage>;
};

export type PlaywrightChromium = {
  launch(options: { executablePath: string; headless: boolean }): Promise<PlaywrightBrowser>;
};

/**
 * playwright-core 是 CJS 包，Node 原生动态 import 时拿不到具名导出 `chromium`，
 * 只能从 default 上取。两种形状都要兼容，否则浏览器抓取回退会直接抛 TypeError。
 */
export function resolvePlaywrightChromium(module: unknown): PlaywrightChromium | undefined {
  const candidate = (module ?? {}) as {
    chromium?: PlaywrightChromium;
    default?: { chromium?: PlaywrightChromium };
  };

  return candidate.chromium ?? candidate.default?.chromium;
}

export async function importPlaywright(): Promise<{ chromium: PlaywrightChromium }> {
  const dynamicImport = new Function(
    "specifier",
    "return import(specifier)"
  ) as (specifier: string) => Promise<unknown>;

  const chromium = resolvePlaywrightChromium(await dynamicImport("playwright-core"));

  if (!chromium) {
    throw new Error("未能加载 playwright-core，请确认依赖已安装。");
  }

  return { chromium };
}

export function resolveChromeExecutable(): string | undefined {
  const configured = process.env.W2F_CHROME_EXECUTABLE_PATH?.trim();

  if (configured) {
    // 配置错路径时（例如误填成飞书 token）不要静默失败，回退到自动探测
    if (existsSync(configured)) {
      return configured;
    }

    console.warn(
      `[w2f] W2F_CHROME_EXECUTABLE_PATH 指向的路径不存在：${configured}，改用自动探测的浏览器。`
    );
  }

  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium"
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * 拉起浏览器执行一次操作，并保证关闭。
 *
 * playwright-core 不自带浏览器二进制，所以找不到可执行文件时给出可操作的提示，
 * 而不是让调用方拿到一个含糊的 launch 失败。
 */
export async function launchChromiumPage<T>(
  run: (page: PlaywrightPage) => Promise<T>,
  options: { userAgent?: string } = {}
): Promise<T> {
  const executablePath = resolveChromeExecutable();

  if (!executablePath) {
    throw new Error(
      "没有找到可用的 Chrome / Chromium。请在 .env 中填写 W2F_CHROME_EXECUTABLE_PATH 指向本机浏览器可执行文件（playwright-core 不自带浏览器）。"
    );
  }

  const { chromium } = await importPlaywright();
  const browser = await chromium.launch({ executablePath, headless: true });

  try {
    return await run(await browser.newPage(options));
  } finally {
    await browser.close();
  }
}
