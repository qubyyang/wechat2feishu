import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildFilterKey,
  deriveCheckpointId,
  ExportCheckpointStore,
  normalizeCheckpointState,
  type CheckpointIdentity
} from "../src/lib/export-checkpoint";
import { buildWechatAccountZip } from "../src/lib/wechat";
import type { WechatArticle, WechatPublishedArticle } from "../src/lib/types";

let workDir = "";

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "w2f-checkpoint-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(workDir, { force: true, recursive: true });
});

const identity: CheckpointIdentity = { accountId: "Mzk5MDcyODQ2Mw==", format: "markdown" };

function listed(count: number): WechatPublishedArticle[] {
  return Array.from({ length: count }, (_, index) => ({
    publishedAt: `2026-01-0${index + 1}`,
    title: `文章${index + 1}`,
    url: `https://mp.weixin.qq.com/s/a${index + 1}`
  }));
}

function article(title: string, url: string): WechatArticle {
  return {
    author: "作者",
    html: `<p>${title} 的正文内容</p>`,
    publishedAt: "2026-01-01",
    sourceUrl: url,
    title
  };
}

describe("deriveCheckpointId", () => {
  it("同参数派生同一 ID，可在无 ID 可传时认出上次任务", () => {
    expect(deriveCheckpointId(identity)).toBe(deriveCheckpointId({ ...identity }));
  });

  it("格式或筛选条件不同则分家，避免复用错格式的分片", () => {
    expect(deriveCheckpointId({ ...identity, format: "pdf" })).not.toBe(
      deriveCheckpointId(identity)
    );
    expect(deriveCheckpointId({ ...identity, filterKey: "kw" })).not.toBe(
      deriveCheckpointId(identity)
    );
  });

  it("ID 为 16 位十六进制，可用于路径校验", () => {
    expect(deriveCheckpointId(identity)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("buildFilterKey", () => {
  it("无筛选返回空串", () => {
    expect(buildFilterKey(undefined)).toBe("");
  });

  it("字段顺序固定，不受对象键序影响", () => {
    expect(buildFilterKey({ keyword: "a", publishedAfter: "2026-01-01" })).toBe(
      buildFilterKey({ publishedAfter: "2026-01-01", keyword: "a" })
    );
  });
});

describe("ExportCheckpointStore", () => {
  it("没有检查点时返回空状态", async () => {
    const state = await new ExportCheckpointStore(workDir).load(identity);

    expect(state.articles).toEqual({});
    expect(state.accountId).toBe("Mzk5MDcyODQ2Mw==");
  });

  it("状态文件损坏时当作没有检查点，而不是拿半份 JSON 去拼包", async () => {
    const store = new ExportCheckpointStore(workDir);
    const dir = join(workDir, deriveCheckpointId(identity));

    await store.writeState(deriveCheckpointId(identity), await store.load(identity));
    await writeFile(join(dir, "state.json"), "{broken", "utf8");

    expect((await store.load(identity)).articles).toEqual({});
  });

  it("逐篇落盘并能读回", async () => {
    const store = new ExportCheckpointStore(workDir);
    const state = await store.load(identity);

    await store.recordArticle({
      article: {
        assetPaths: ["assets/img.png"],
        filename: "001-demo.md",
        searchText: "正文",
        status: "success",
        title: "demo",
        url: "https://mp.weixin.qq.com/s/a1"
      },
      assets: [{ data: Buffer.from("PNG"), path: "assets/img.png" }],
      identity,
      rendered: Buffer.from("# demo"),
      state
    });

    const id = deriveCheckpointId(identity);

    expect((await store.readArticle(id, "001-demo.md"))?.toString()).toBe("# demo");
    expect((await store.readAsset(id, "assets/img.png"))?.toString()).toBe("PNG");
    expect((await store.load(identity)).articles["https://mp.weixin.qq.com/s/a1"]?.title).toBe(
      "demo"
    );
  });

  it("资源路径中的 ../ 不会逃逸出检查点目录", async () => {
    const store = new ExportCheckpointStore(workDir);
    const state = await store.load(identity);

    await store.recordArticle({
      article: {
        assetPaths: ["../../escape.png"],
        filename: "001-demo.md",
        searchText: "",
        status: "success",
        title: "demo",
        url: "https://mp.weixin.qq.com/s/a1"
      },
      assets: [{ data: Buffer.from("X"), path: "../../escape.png" }],
      identity,
      rendered: Buffer.from("#"),
      state
    });

    await expect(readFile(join(workDir, "..", "..", "escape.png"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("discard 后检查点消失", async () => {
    const store = new ExportCheckpointStore(workDir);

    await store.writeState(deriveCheckpointId(identity), await store.load(identity));
    expect(await store.list()).toHaveLength(1);

    await store.discard(identity);
    expect(await store.list()).toEqual([]);
  });

  it("discardById 拒绝非法 ID，防止路径穿越", async () => {
    await expect(new ExportCheckpointStore(workDir).discardById("../etc")).rejects.toThrow(
      "检查点 ID 非法"
    );
  });

  it("超过 TTL 的检查点在列举时被清理", async () => {
    const store = new ExportCheckpointStore(workDir);
    const id = deriveCheckpointId(identity);
    const state = await store.load(identity);

    state.updatedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await store.writeState(id, state);

    expect(await store.list({ ttlMs: 24 * 60 * 60 * 1000 })).toEqual([]);
    expect(await store.list()).toEqual([]);
  });

  it("list 统计成功与失败篇数", async () => {
    const store = new ExportCheckpointStore(workDir);
    const state = await store.load(identity);

    state.articles = {
      "https://a": {
        assetPaths: [],
        filename: "001.md",
        searchText: "",
        status: "success",
        title: "a",
        url: "https://a"
      },
      "https://b": {
        assetPaths: [],
        searchText: "",
        status: "failed",
        title: "b",
        url: "https://b"
      }
    };
    await store.writeState(deriveCheckpointId(identity), state);

    expect(await store.list()).toEqual([
      expect.objectContaining({ accountId: "Mzk5MDcyODQ2Mw==", doneCount: 1, failedCount: 1 })
    ]);
  });
});

describe("normalizeCheckpointState", () => {
  it("非法输入退化为空状态", () => {
    expect(normalizeCheckpointState(null, identity).articles).toEqual({});
  });

  it("以键名回填 url 并补齐缺失字段", () => {
    const state = normalizeCheckpointState(
      { articles: { "https://a": { title: "T" } } },
      identity
    );

    expect(state.articles["https://a"]).toMatchObject({
      assetPaths: [],
      searchText: "",
      status: "success",
      url: "https://a"
    });
  });
});

describe("buildWechatAccountZip 断点续传", () => {
  it("命中检查点的文章不再调用 convert，也不消耗限速等待", async () => {
    const store = new ExportCheckpointStore(workDir);
    const articles = listed(3);
    const convert = vi.fn(async (url: string) => ({
      article: article(`文章${url.slice(-1)}`, url),
      markdown: `# 文章${url.slice(-1)}`
    }));

    // 第一次：全部抓取并落盘
    const first = await buildWechatAccountZip({
      accountId: "Mzk5MDcyODQ2Mw==",
      articles,
      checkpoint: { identity, state: await store.load(identity), store },
      convert,
      downloadAssets: false,
      intervalMs: 0
    });

    expect(first.successCount).toBe(3);
    expect(first.resumedCount).toBe(0);
    expect(convert).toHaveBeenCalledTimes(3);

    // 第二次：同参数重跑，应全部复用
    convert.mockClear();

    const second = await buildWechatAccountZip({
      accountId: "Mzk5MDcyODQ2Mw==",
      articles,
      checkpoint: { identity, state: await store.load(identity), store },
      convert,
      downloadAssets: false,
      intervalMs: 0
    });

    expect(convert).not.toHaveBeenCalled();
    expect(second.resumedCount).toBe(3);
    expect(second.successCount).toBe(3);

    // 复用出来的 ZIP 必须包含真实文章内容，而不是空壳
    const zip = await JSZip.loadAsync(second.zip);
    const names = Object.keys(zip.files).filter((name) => name.endsWith(".md"));
    expect(names).toHaveLength(3);
    expect(await zip.file(names[0]!)!.async("string")).toContain("文章");
  });

  it("中断后重跑只补齐缺口，已抓部分不重复请求", async () => {
    const store = new ExportCheckpointStore(workDir);
    const articles = listed(3);
    let calls = 0;
    const flaky = vi.fn(async (url: string) => {
      calls += 1;
      // 第 3 篇失败，模拟撞上频控
      if (calls === 3) throw new Error("freq control");
      return { article: article(`文章${calls}`, url), markdown: `# 文章${calls}` };
    });

    const first = await buildWechatAccountZip({
      accountId: "Mzk5MDcyODQ2Mw==",
      articles,
      checkpoint: { identity, state: await store.load(identity), store },
      convert: flaky,
      downloadAssets: false,
      intervalMs: 0
    });

    expect(first.successCount).toBe(2);
    expect(first.failureCount).toBe(1);

    const retry = vi.fn(async (url: string) => ({
      article: article("补齐的文章", url),
      markdown: "# 补齐的文章"
    }));

    const second = await buildWechatAccountZip({
      accountId: "Mzk5MDcyODQ2Mw==",
      articles,
      checkpoint: { identity, state: await store.load(identity), store },
      convert: retry,
      downloadAssets: false,
      intervalMs: 0
    });

    // 只补第 3 篇：前两篇的抓取配额被检查点保住了
    expect(retry).toHaveBeenCalledTimes(1);
    expect(second.resumedCount).toBe(2);
    expect(second.successCount).toBe(3);
  });

  it("分片文件缺失时回退到重新抓取，而不是产出缺内容的包", async () => {
    const store = new ExportCheckpointStore(workDir);
    const articles = listed(1);
    const convert = vi.fn(async (url: string) => ({
      article: article("文章1", url),
      markdown: "# 文章1"
    }));

    await buildWechatAccountZip({
      accountId: "Mzk5MDcyODQ2Mw==",
      articles,
      checkpoint: { identity, state: await store.load(identity), store },
      convert,
      downloadAssets: false,
      intervalMs: 0
    });

    // 手工删掉分片，模拟磁盘内容丢失但状态仍在
    const state = await store.load(identity);
    const filename = state.articles[articles[0]!.url]!.filename!;
    await rm(join(workDir, deriveCheckpointId(identity), "articles", filename));

    convert.mockClear();

    const second = await buildWechatAccountZip({
      accountId: "Mzk5MDcyODQ2Mw==",
      articles,
      checkpoint: { identity, state: await store.load(identity), store },
      convert,
      downloadAssets: false,
      intervalMs: 0
    });

    expect(convert).toHaveBeenCalledTimes(1);
    expect(second.resumedCount).toBe(0);
    expect(second.successCount).toBe(1);
  });

  it("不传 checkpoint 时行为不变", async () => {
    const convert = vi.fn(async (url: string) => ({
      article: article("文章1", url),
      markdown: "# 文章1"
    }));

    const result = await buildWechatAccountZip({
      accountId: "Mzk5MDcyODQ2Mw==",
      articles: listed(2),
      convert,
      downloadAssets: false,
      intervalMs: 0
    });

    expect(convert).toHaveBeenCalledTimes(2);
    expect(result.resumedCount).toBe(0);
  });
});
