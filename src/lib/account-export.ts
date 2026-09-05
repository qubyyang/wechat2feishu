import { ArchiveIndexStore, filterUnarchivedArticles } from "./archive-index";
import { assertWechatBatchConfig, getServerConfig } from "./env";
import { HistoryStore } from "./history";
import { safeDocumentTitle } from "./safe";
import type { ExportFormat, ExportProgressEvent } from "./types";
import {
  buildWechatAccountZip,
  fetchWechatAccountArticles,
  parseFilterDate,
  type WechatArticleFilter
} from "./wechat";

export type AccountExportOutcome = {
  assetCount: number;
  filename: string;
  skippedCount: number;
  successCount: number;
  warnings: string[];
  zip: Buffer;
};

export type AccountExportOptions = {
  accountId: string;
  filter?: WechatArticleFilter;
  format: ExportFormat;
  /** 增量模式：跳过索引中已归档的文章，默认开启 */
  incremental?: boolean;
  limit?: number;
  onProgress?: (event: ExportProgressEvent) => void;
};

/**
 * 「已全部归档」是业务结果而非抓取故障，需要和真正的失败区分：
 * HTTP 层返回 409 而不是 400，定时任务也不应把它计为失败。
 */
export class NothingToExportError extends Error {}

/** 只保留真正生效的筛选条件，全空时返回 undefined 以走原有的快路径 */
export function parseArticleFilter(input: {
  keyword?: string;
  originalOnly?: boolean;
  publishedAfter?: string;
  publishedBefore?: string;
}): WechatArticleFilter | undefined {
  const filter: WechatArticleFilter = {
    keyword: input.keyword?.trim() || undefined,
    originalOnly: input.originalOnly === true ? true : undefined,
    publishedAfter: input.publishedAfter?.trim() || undefined,
    publishedBefore: input.publishedBefore?.trim() || undefined
  };

  // 提前解析一次，让非法日期在抓取前就报错，而不是浪费配额之后才失败
  const after = parseFilterDate(filter.publishedAfter);
  const before = parseFilterDate(filter.publishedBefore, true);

  if (after !== undefined && before !== undefined && after > before) {
    throw new Error("起始日期不能晚于结束日期。");
  }

  return Object.values(filter).some((value) => value !== undefined) ? filter : undefined;
}

/**
 * 批量导出内核。HTTP 路由与定时调度器共用同一份实现——调度器若走 HTTP 自调用，
 * 既要处理鉴权与 baseUrl，也会让频控失去统一入口，因此直接函数调用。
 */
export async function runAccountExport(
  options: AccountExportOptions
): Promise<AccountExportOutcome> {
  const { accountId, filter, format, onProgress } = options;
  const config = getServerConfig();
  const archiveIndex = new ArchiveIndexStore(config.archiveIndexPath);
  const incremental = options.incremental !== false;
  const credentials = assertWechatBatchConfig(config);
  const warnings: string[] = [];

  onProgress?.({ message: "正在获取文章列表…", stage: "listing" });

  const listed = await fetchWechatAccountArticles({
    accountId,
    cookie: credentials.wechatMpCookie,
    filter,
    intervalMs: config.wechatListIntervalMs,
    limit: options.limit,
    maxRetries: config.wechatMaxRetries,
    onProgress,
    onWarning: (message) => warnings.push(message),
    pageSize: config.wechatListPageSize,
    retryBaseMs: config.wechatRetryBaseMs,
    token: credentials.wechatMpToken
  });

  if (!listed.length) {
    throw new Error(
      filter
        ? "没有符合筛选条件的文章。请放宽关键词或时间范围后重试。"
        : "没有获取到该公众号的文章列表。"
    );
  }

  // 在抓正文之前剔除已归档文章：列表配额已经花掉了，但正文抓取才是大头
  const archivedUrls = incremental
    ? await archiveIndex.listArchivedUrls(accountId)
    : new Set<string>();
  const { skipped, unarchived } = filterUnarchivedArticles(listed, archivedUrls);

  if (!unarchived.length) {
    throw new NothingToExportError(
      `本次列出的 ${listed.length} 篇文章都已归档过，没有新增内容。如需重新导出，请关闭增量模式。`
    );
  }

  if (skipped.length) {
    warnings.push(`增量模式跳过 ${skipped.length} 篇已归档文章。`);
  }

  const result = await buildWechatAccountZip({
    accountId,
    articles: unarchived,
    assetIntervalMs: config.assetIntervalMs,
    assetMaxBytes: config.assetMaxBytes,
    downloadMedia: config.downloadMedia,
    format,
    intervalMs: config.wechatArticleIntervalMs,
    onProgress,
    onWarning: (message) => warnings.push(message)
  });

  await archiveIndex.record(
    accountId,
    result.archived.map((item) => ({
      archivedAt: new Date().toISOString(),
      filename: item.filename,
      publishedAt: item.publishedAt,
      title: item.title,
      url: item.url
    }))
  );

  const history = new HistoryStore(config.historyPath);
  await history.add({
    sourceUrl: `wechat-account:${accountId}`,
    status: result.successCount > 0 ? "success" : "failed",
    target: format,
    title: `${accountId} 批量导出 ${result.successCount}/${unarchived.length}${
      skipped.length ? `（增量跳过 ${skipped.length} 篇）` : ""
    }${warnings.length ? `（${warnings.length} 条提示）` : ""}`
  });

  if (warnings.length) {
    console.warn("[account-export] 抓取过程提示：\n - " + warnings.join("\n - "));
  }

  return {
    assetCount: result.assetCount,
    filename: `${safeDocumentTitle(accountId)}-公众号文章.zip`,
    skippedCount: skipped.length,
    successCount: result.successCount,
    warnings,
    zip: result.zip
  };
}

export async function recordAccountExportFailure(
  accountId: string,
  format: ExportFormat,
  message: string
): Promise<void> {
  if (!accountId) return;

  const history = new HistoryStore(getServerConfig().historyPath);
  await history.add({
    error: message,
    sourceUrl: `wechat-account:${accountId}`,
    status: "failed",
    target: format,
    title: "批量导出失败"
  });
}
