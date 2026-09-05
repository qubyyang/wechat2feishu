import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { SearchIndexFile, SearchIndexDocument, SearchHit } from "./types";

const SEARCH_INDEX_VERSION = 1;

/** 单篇正文入库的字符上限。索引文件是整体读写的 JSON，不设上限会让长文把它撑爆 */
export const SEARCH_TEXT_MAX_CHARS = 20_000;

/** 摘要片段长度，命中词居中展开 */
const SNIPPET_RADIUS = 40;

/**
 * 中英混排分词。
 *
 * 中文不像英文有空格可依，做真正的词法分析要带词典，体积与维护成本都不划算。
 * 这里对 CJK 走**二元切分**（bigram）：把「公众号文章」切成「公众/众号/号文/文章」，
 * 检索时同样切分后取交集——代价是索引条目变多，换来的是不依赖词典也能召回任意子串，
 * 且不会像单字切分那样把「上海」和「海上」判为等价。
 * 拉丁字母与数字按连续串切分并小写化。
 */
export function tokenize(value: string): string[] {
  const tokens: string[] = [];
  const normalized = value.toLowerCase();
  const latin = /[a-z0-9_]+/gi;
  const cjk = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g;

  for (const match of normalized.matchAll(latin)) {
    tokens.push(match[0]);
  }

  for (const match of normalized.matchAll(cjk)) {
    const run = match[0];

    // 单字查询（如「税」）没有二元组可切，退化为单字 token 才能被检索到
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }

    for (let i = 0; i + 1 < run.length; i += 1) {
      tokens.push(run.slice(i, i + 2));
    }
  }

  return tokens;
}

export function emptySearchIndex(): SearchIndexFile {
  return { accounts: {}, version: SEARCH_INDEX_VERSION };
}

export function normalizeSearchIndex(value: unknown): SearchIndexFile {
  const root = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const accountsRaw =
    root.accounts && typeof root.accounts === "object"
      ? (root.accounts as Record<string, unknown>)
      : {};
  const accounts: SearchIndexFile["accounts"] = {};

  for (const [accountId, bucketRaw] of Object.entries(accountsRaw)) {
    const bucket =
      bucketRaw && typeof bucketRaw === "object" ? (bucketRaw as Record<string, unknown>) : {};
    const docsRaw =
      bucket.documents && typeof bucket.documents === "object"
        ? (bucket.documents as Record<string, unknown>)
        : {};
    const documents: Record<string, SearchIndexDocument> = {};

    for (const [url, docRaw] of Object.entries(docsRaw)) {
      const doc = docRaw && typeof docRaw === "object" ? (docRaw as Record<string, unknown>) : {};

      documents[url] = {
        indexedAt: typeof doc.indexedAt === "string" ? doc.indexedAt : new Date(0).toISOString(),
        publishedAt: typeof doc.publishedAt === "string" ? doc.publishedAt : undefined,
        text: typeof doc.text === "string" ? doc.text : "",
        title: typeof doc.title === "string" ? doc.title : "",
        url
      };
    }

    accounts[accountId] = { documents, updatedAt: typeof bucket.updatedAt === "string" ? bucket.updatedAt : "" };
  }

  return { accounts, version: SEARCH_INDEX_VERSION };
}

export type SearchOptions = {
  accountId?: string;
  limit?: number;
};

/**
 * 检索。多个查询词之间是 **AND** 关系——归档库里同一主题的文章往往高度相似，
 * OR 会把弱相关结果一并捞上来，反而更难定位。
 *
 * 倒排索引在查询时按需构建而不是随文件持久化：索引文件已经存了全文，
 * 落盘倒排表会让文件体积翻倍，而查询本身是低频操作，重建代价可以接受。
 */
export function searchIndex(
  file: SearchIndexFile,
  query: string,
  options: SearchOptions = {}
): SearchHit[] {
  const terms = Array.from(new Set(tokenize(query)));
  if (!terms.length) return [];

  const limit = options.limit && options.limit > 0 ? options.limit : 20;
  const hits: SearchHit[] = [];
  const buckets = options.accountId
    ? [[options.accountId, file.accounts[options.accountId]] as const]
    : Object.entries(file.accounts);

  for (const [accountId, bucket] of buckets) {
    if (!bucket) continue;

    for (const doc of Object.values(bucket.documents)) {
      // 标题命中权重更高：归档检索多半是在找「那篇讲 X 的文章」
      const haystack = `${doc.title}\n${doc.text}`.toLowerCase();
      const docTokens = new Set(tokenize(haystack));

      if (!terms.every((term) => matchTerm(term, docTokens, haystack))) continue;

      const titleLower = doc.title.toLowerCase();
      const queryLower = query.trim().toLowerCase();
      let score = terms.length;

      // 原串整体出现在正文/标题里，说明不是二元组碰巧凑齐的伪命中
      if (haystack.includes(queryLower)) score += 3;
      if (titleLower.includes(queryLower)) score += 5;

      hits.push({
        accountId,
        publishedAt: doc.publishedAt,
        score,
        snippet: buildSnippet(doc.text, queryLower, terms),
        title: doc.title,
        url: doc.url
      });
    }
  }

  return hits
    .sort((a, b) => b.score - a.score || (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
    .slice(0, limit);
}

/**
 * 词元匹配。
 *
 * 二元切分下，长度为 1 的查询词元（单个汉字，如「税」）在文档侧根本不存在——
 * 文档里的「税收」只会产出「税收」这个二元组。若只查倒排集合，单字查询会**全部漏召**。
 * 因此单字词元退回子串匹配；二元及以上仍走集合，保持精确与速度。
 */
function matchTerm(term: string, docTokens: Set<string>, haystack: string): boolean {
  if (docTokens.has(term)) return true;
  return term.length === 1 && haystack.includes(term);
}

/** 以命中位置为中心截取摘要；找不到原串时退化为按第一个词元定位 */
export function buildSnippet(text: string, query: string, terms: string[]): string {
  if (!text) return "";

  const lower = text.toLowerCase();
  let at = query ? lower.indexOf(query) : -1;

  if (at < 0) {
    for (const term of terms) {
      at = lower.indexOf(term);
      if (at >= 0) break;
    }
  }

  if (at < 0) return text.slice(0, SNIPPET_RADIUS * 2).trim();

  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + query.length + SNIPPET_RADIUS);

  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${
    end < text.length ? "…" : ""
  }`;
}

/**
 * 把 Markdown 正文压成用于检索的纯文本。
 * 只需要「能被搜到」，不需要还原排版，因此语法标记一律剥掉。
 */
export function markdownToSearchText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[>#\-*+\s]+/gm, " ")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SEARCH_TEXT_MAX_CHARS);
}

export class SearchIndexStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  async read(): Promise<SearchIndexFile> {
    try {
      return normalizeSearchIndex(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // 索引损坏或缺失都退化成空索引：检索是增值能力，不该阻断导出
      if (code === "ENOENT" || error instanceof SyntaxError) return emptySearchIndex();
      throw error;
    }
  }

  /** 按 URL 覆盖写入；重复归档同一篇文章只会刷新内容，不会产生重复条目 */
  async record(
    accountId: string,
    documents: Array<Omit<SearchIndexDocument, "indexedAt">>
  ): Promise<void> {
    if (!documents.length) return;

    const file = await this.read();
    const bucket = file.accounts[accountId] ?? { documents: {}, updatedAt: "" };
    const indexedAt = new Date().toISOString();

    for (const doc of documents) {
      if (!doc.url) continue;
      bucket.documents[doc.url] = { ...doc, indexedAt };
    }

    bucket.updatedAt = indexedAt;
    file.accounts[accountId] = bucket;

    await this.write(file);
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    return searchIndex(await this.read(), query, options);
  }

  async stats(): Promise<Array<{ accountId: string; documentCount: number; updatedAt: string }>> {
    const file = await this.read();

    return Object.entries(file.accounts).map(([accountId, bucket]) => ({
      accountId,
      documentCount: Object.keys(bucket.documents).length,
      updatedAt: bucket.updatedAt
    }));
  }

  private async write(file: SearchIndexFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(file)}\n`, "utf8");
  }
}
