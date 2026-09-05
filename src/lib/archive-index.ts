import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type {
  ArchiveIndexEntry,
  ArchiveIndexFile,
  WechatPublishedArticle
} from "./types";

const ARCHIVE_INDEX_VERSION = 1;

/**
 * 跨次导出的去重索引。
 *
 * 刻意**不复用** history.json：那份记录有 slice(0, 100) 上限，超出后旧记录被静默
 * 丢弃，拿它当去重依据会漏判成"未归档"从而重复抓取——既浪费频控配额，也让增量
 * 导出失去意义。本索引不设条数上限，只按 accountId 分桶。
 */
export class ArchiveIndexStore {
  private readonly filePath: string;

  constructor(filePath = process.env.W2F_ARCHIVE_INDEX_PATH ?? "./data/archive-index.json") {
    this.filePath = resolve(filePath);
  }

  /** 返回该公众号下已归档的文章 URL 集合 */
  async listArchivedUrls(accountId: string): Promise<Set<string>> {
    const file = await this.read();
    return new Set(Object.keys(file.accounts[accountId]?.articles ?? {}));
  }

  async listEntries(accountId: string): Promise<ArchiveIndexEntry[]> {
    const file = await this.read();
    return Object.values(file.accounts[accountId]?.articles ?? {});
  }

  /** 批量登记本次成功归档的文章；已存在的条目保留首次归档时间 */
  async record(accountId: string, entries: ArchiveIndexEntry[]): Promise<void> {
    if (!entries.length) return;

    const file = await this.read();
    const bucket = file.accounts[accountId] ?? { articles: {}, updatedAt: "" };

    for (const entry of entries) {
      const existing = bucket.articles[entry.url];
      bucket.articles[entry.url] = existing
        ? { ...entry, archivedAt: existing.archivedAt }
        : entry;
    }

    bucket.updatedAt = new Date().toISOString();
    file.accounts[accountId] = bucket;

    await this.write(file);
  }

  async clear(accountId?: string): Promise<void> {
    if (!accountId) {
      await this.write({ accounts: {}, version: ARCHIVE_INDEX_VERSION });
      return;
    }

    const file = await this.read();
    delete file.accounts[accountId];
    await this.write(file);
  }

  private async read(): Promise<ArchiveIndexFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      return normalizeArchiveIndex(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { accounts: {}, version: ARCHIVE_INDEX_VERSION };
      }

      // 索引损坏不应该阻断导出，退化成"全部未归档"重新开始
      if (error instanceof SyntaxError) {
        return { accounts: {}, version: ARCHIVE_INDEX_VERSION };
      }

      throw error;
    }
  }

  private async write(file: ArchiveIndexFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  }
}

export function normalizeArchiveIndex(value: unknown): ArchiveIndexFile {
  const root = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const accountsRaw =
    root.accounts && typeof root.accounts === "object"
      ? (root.accounts as Record<string, unknown>)
      : {};
  const accounts: ArchiveIndexFile["accounts"] = {};

  for (const [accountId, bucketRaw] of Object.entries(accountsRaw)) {
    const bucket = bucketRaw && typeof bucketRaw === "object" ? (bucketRaw as Record<string, unknown>) : {};
    const articlesRaw =
      bucket.articles && typeof bucket.articles === "object"
        ? (bucket.articles as Record<string, unknown>)
        : {};
    const articles: Record<string, ArchiveIndexEntry> = {};

    for (const [url, entryRaw] of Object.entries(articlesRaw)) {
      const entry = entryRaw && typeof entryRaw === "object" ? (entryRaw as Record<string, unknown>) : {};
      if (typeof entry.url !== "string" && typeof url !== "string") continue;

      articles[url] = {
        archivedAt: typeof entry.archivedAt === "string" ? entry.archivedAt : new Date(0).toISOString(),
        filename: typeof entry.filename === "string" ? entry.filename : undefined,
        publishedAt: typeof entry.publishedAt === "string" ? entry.publishedAt : undefined,
        title: typeof entry.title === "string" ? entry.title : "",
        url
      };
    }

    accounts[accountId] = {
      articles,
      updatedAt: typeof bucket.updatedAt === "string" ? bucket.updatedAt : ""
    };
  }

  return { accounts, version: ARCHIVE_INDEX_VERSION };
}

/**
 * 过滤掉已归档的文章。
 *
 * 只在**抓正文之前**调用——列表接口已经付出过配额，但正文抓取是大头，
 * 提前剔除才有节流意义。
 */
export function filterUnarchivedArticles(
  articles: WechatPublishedArticle[],
  archivedUrls: ReadonlySet<string>
): { skipped: WechatPublishedArticle[]; unarchived: WechatPublishedArticle[] } {
  const skipped: WechatPublishedArticle[] = [];
  const unarchived: WechatPublishedArticle[] = [];

  for (const article of articles) {
    (archivedUrls.has(article.url) ? skipped : unarchived).push(article);
  }

  return { skipped, unarchived };
}
