import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { ExportFormat } from "./types";

const CHECKPOINT_VERSION = 1;

/** 状态文件名，与文章分片同目录 */
const STATE_FILENAME = "state.json";
const ARTICLES_DIRNAME = "articles";
const ASSETS_DIRNAME = "assets";

export type CheckpointIdentity = {
  accountId: string;
  filterKey?: string;
  format: ExportFormat;
};

export type CheckpointArticle = {
  /** ZIP 内的文件名，续传时原样复用以保持编号连续 */
  filename?: string;
  publishedAt?: string;
  /** 该篇引用的资源在 assets/ 下的相对路径 */
  assetPaths: string[];
  searchText: string;
  status: "failed" | "success";
  title: string;
  url: string;
};

export type CheckpointState = {
  accountId: string;
  createdAt: string;
  format: ExportFormat;
  /** 已处理过的文章，按 URL 索引；续传时据此跳过 */
  articles: Record<string, CheckpointArticle>;
  updatedAt: string;
  version: number;
};

export type CheckpointSummary = {
  accountId: string;
  checkpointId: string;
  createdAt: string;
  doneCount: number;
  failedCount: number;
  format: ExportFormat;
  updatedAt: string;
};

/**
 * 检查点 ID 必须是**确定性**的，不能用随机 UUID。
 *
 * 续传的前提是「同一批导出」能在下次请求时被认出来，而用户重试时手上只有
 * 公众号 ID、格式和筛选条件——没有任何 ID 可传。因此直接由这三者哈希派生：
 * 同样的参数必然落到同一个检查点，换了格式或筛选条件则自然分家，避免把
 * markdown 的分片错当成 pdf 的成果复用。
 */
export function deriveCheckpointId(identity: CheckpointIdentity): string {
  const payload = [identity.accountId, identity.format, identity.filterKey ?? ""].join("\u0000");

  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/** 把筛选条件压成稳定字符串；字段顺序固定，避免对象键序影响哈希 */
export function buildFilterKey(filter?: {
  keyword?: string;
  originalOnly?: boolean;
  publishedAfter?: string;
  publishedBefore?: string;
}): string {
  if (!filter) return "";

  return [
    filter.keyword ?? "",
    filter.originalOnly ? "1" : "",
    filter.publishedAfter ?? "",
    filter.publishedBefore ?? ""
  ].join("|");
}

function emptyState(identity: CheckpointIdentity): CheckpointState {
  const now = new Date().toISOString();

  return {
    accountId: identity.accountId,
    articles: {},
    createdAt: now,
    format: identity.format,
    updatedAt: now,
    version: CHECKPOINT_VERSION
  };
}

export function normalizeCheckpointState(
  value: unknown,
  identity: CheckpointIdentity
): CheckpointState {
  const root = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const articlesRaw =
    root.articles && typeof root.articles === "object"
      ? (root.articles as Record<string, unknown>)
      : {};
  const articles: Record<string, CheckpointArticle> = {};

  for (const [url, itemRaw] of Object.entries(articlesRaw)) {
    const item =
      itemRaw && typeof itemRaw === "object" ? (itemRaw as Record<string, unknown>) : {};

    articles[url] = {
      assetPaths: Array.isArray(item.assetPaths)
        ? item.assetPaths.filter((path): path is string => typeof path === "string")
        : [],
      filename: typeof item.filename === "string" ? item.filename : undefined,
      publishedAt: typeof item.publishedAt === "string" ? item.publishedAt : undefined,
      searchText: typeof item.searchText === "string" ? item.searchText : "",
      status: item.status === "failed" ? "failed" : "success",
      title: typeof item.title === "string" ? item.title : "",
      url
    };
  }

  const fallback = emptyState(identity);

  return {
    accountId: typeof root.accountId === "string" ? root.accountId : identity.accountId,
    articles,
    createdAt: typeof root.createdAt === "string" ? root.createdAt : fallback.createdAt,
    format: typeof root.format === "string" ? (root.format as ExportFormat) : identity.format,
    updatedAt: typeof root.updatedAt === "string" ? root.updatedAt : fallback.updatedAt,
    version: CHECKPOINT_VERSION
  };
}

/**
 * 导出检查点。
 *
 * 解决的问题：批量导出到第 N 篇才失败时，前 N-1 篇消耗掉的微信频控配额会全部
 * 白费——而配额恰恰是本项目最贵的资源，触发 freq control 的惩罚可达数小时。
 * 因此每抓完一篇就立刻把渲染结果与资源字节落盘，重试时只补齐缺口。
 *
 * 分片落到磁盘而不是留在内存：进程崩溃、容器重启、serverless 实例回收都会让
 * 内存态灰飞烟灭，而这些恰恰是长任务最常见的中断原因。
 */
export class ExportCheckpointStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  private dirFor(checkpointId: string): string {
    return join(this.rootDir, checkpointId);
  }

  async load(identity: CheckpointIdentity): Promise<CheckpointState> {
    const checkpointId = deriveCheckpointId(identity);

    try {
      const raw = await readFile(join(this.dirFor(checkpointId), STATE_FILENAME), "utf8");
      return normalizeCheckpointState(JSON.parse(raw), identity);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // 状态损坏等同于没有检查点：宁可重抓一遍，也不能拿半个 JSON 去拼 ZIP
      if (code === "ENOENT" || error instanceof SyntaxError) return emptyState(identity);
      throw error;
    }
  }

  /** 读取某篇文章已落盘的渲染结果；缺失返回 undefined 让调用方回退到重新抓取 */
  async readArticle(checkpointId: string, filename: string): Promise<Buffer | undefined> {
    try {
      return await readFile(join(this.dirFor(checkpointId), ARTICLES_DIRNAME, filename));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async readAsset(checkpointId: string, assetPath: string): Promise<Buffer | undefined> {
    // assetPath 来自状态文件，仍按 basename 取用，避免 ../ 逃逸出检查点目录
    const safe = assetPath.split("/").filter((part) => part && part !== "." && part !== "..");

    try {
      return await readFile(join(this.dirFor(checkpointId), ASSETS_DIRNAME, ...safe));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /**
   * 记录一篇处理完毕的文章。每篇单独落盘并立刻刷新状态——批量攒到最后再写，
   * 等于把「中断即丢失」的问题原样搬回来了。
   */
  async recordArticle(options: {
    article: CheckpointArticle;
    assets?: Array<{ data: Buffer; path: string }>;
    identity: CheckpointIdentity;
    rendered?: Buffer;
    state: CheckpointState;
  }): Promise<void> {
    const checkpointId = deriveCheckpointId(options.identity);
    const dir = this.dirFor(checkpointId);

    if (options.rendered && options.article.filename) {
      await mkdir(join(dir, ARTICLES_DIRNAME), { recursive: true });
      await writeFile(join(dir, ARTICLES_DIRNAME, options.article.filename), options.rendered);
    }

    for (const asset of options.assets ?? []) {
      const safe = asset.path.split("/").filter((part) => part && part !== "." && part !== "..");
      if (!safe.length) continue;

      const target = join(dir, ASSETS_DIRNAME, ...safe);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, asset.data);
    }

    options.state.articles[options.article.url] = options.article;
    options.state.updatedAt = new Date().toISOString();

    await this.writeState(checkpointId, options.state);
  }

  async writeState(checkpointId: string, state: CheckpointState): Promise<void> {
    const dir = this.dirFor(checkpointId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, STATE_FILENAME), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  /** 导出成功后清理，避免下次同参数导出误复用陈旧分片 */
  async discard(identity: CheckpointIdentity): Promise<void> {
    await rm(this.dirFor(deriveCheckpointId(identity)), { force: true, recursive: true });
  }

  async discardById(checkpointId: string): Promise<void> {
    if (!/^[0-9a-f]{16}$/.test(checkpointId)) {
      throw new Error("检查点 ID 非法。");
    }

    await rm(this.dirFor(checkpointId), { force: true, recursive: true });
  }

  /** 列出可续传的检查点，供前端展示未完成任务 */
  async list(options: { ttlMs?: number } = {}): Promise<CheckpointSummary[]> {
    let entries: string[];

    try {
      entries = await readdir(this.rootDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const summaries: CheckpointSummary[] = [];
    const now = Date.now();

    for (const checkpointId of entries) {
      if (!/^[0-9a-f]{16}$/.test(checkpointId)) continue;

      let state: CheckpointState;

      try {
        const raw = await readFile(join(this.dirFor(checkpointId), STATE_FILENAME), "utf8");
        state = JSON.parse(raw) as CheckpointState;
      } catch {
        continue;
      }

      const updatedAt = Date.parse(state.updatedAt ?? "");

      // 过期检查点顺带清理：留着只会让「可续传」列表越积越长且内容早已失效
      if (options.ttlMs && Number.isFinite(updatedAt) && now - updatedAt > options.ttlMs) {
        await this.discardById(checkpointId);
        continue;
      }

      const articles = Object.values(state.articles ?? {});

      summaries.push({
        accountId: state.accountId,
        checkpointId,
        createdAt: state.createdAt,
        doneCount: articles.filter((item) => item.status === "success").length,
        failedCount: articles.filter((item) => item.status === "failed").length,
        format: state.format,
        updatedAt: state.updatedAt
      });
    }

    return summaries.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }
}
