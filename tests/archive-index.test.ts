import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  ArchiveIndexStore,
  filterUnarchivedArticles,
  normalizeArchiveIndex
} from "@/lib/archive-index";
import type { WechatPublishedArticle } from "@/lib/types";

const ACCOUNT = "Mzk5MDcyODQ2Mw==";

function article(url: string, title = url): WechatPublishedArticle {
  return { title, url };
}

describe("ArchiveIndexStore", () => {
  let dir: string;
  let indexPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "w2f-index-"));
    indexPath = join(dir, "nested", "archive-index.json");
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  test("索引文件不存在时返回空集合，不抛错", async () => {
    const store = new ArchiveIndexStore(indexPath);
    await expect(store.listArchivedUrls(ACCOUNT)).resolves.toEqual(new Set());
  });

  test("记录后可跨实例读取，且按 accountId 分桶隔离", async () => {
    await new ArchiveIndexStore(indexPath).record(ACCOUNT, [
      { archivedAt: "2026-09-04T00:00:00.000Z", title: "第一篇", url: "https://mp.weixin.qq.com/s/a" }
    ]);

    const reopened = new ArchiveIndexStore(indexPath);
    await expect(reopened.listArchivedUrls(ACCOUNT)).resolves.toEqual(
      new Set(["https://mp.weixin.qq.com/s/a"])
    );
    await expect(reopened.listArchivedUrls("OtherAccount==")).resolves.toEqual(new Set());
  });

  test("重复登记保留首次归档时间，但更新标题等元数据", async () => {
    const store = new ArchiveIndexStore(indexPath);
    const url = "https://mp.weixin.qq.com/s/a";

    await store.record(ACCOUNT, [
      { archivedAt: "2026-01-01T00:00:00.000Z", title: "旧标题", url }
    ]);
    await store.record(ACCOUNT, [
      { archivedAt: "2026-09-04T00:00:00.000Z", filename: "001-新标题.md", title: "新标题", url }
    ]);

    const [entry] = await store.listEntries(ACCOUNT);
    expect(entry.archivedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(entry.title).toBe("新标题");
    expect(entry.filename).toBe("001-新标题.md");
  });

  test("超过 100 条也不丢记录（这正是不复用 history.json 的原因）", async () => {
    const store = new ArchiveIndexStore(indexPath);
    const entries = Array.from({ length: 250 }, (_, index) => ({
      archivedAt: "2026-09-04T00:00:00.000Z",
      title: `第 ${index} 篇`,
      url: `https://mp.weixin.qq.com/s/${index}`
    }));

    await store.record(ACCOUNT, entries);
    await expect(store.listArchivedUrls(ACCOUNT)).resolves.toHaveProperty("size", 250);
  });

  test("索引文件损坏时退化为空索引，不阻断导出", async () => {
    await writeFile(join(dir, "broken.json"), "{ not json", "utf8");
    const store = new ArchiveIndexStore(join(dir, "broken.json"));

    await expect(store.listArchivedUrls(ACCOUNT)).resolves.toEqual(new Set());
  });

  test("clear 可按账号清理，也可整体清空", async () => {
    const store = new ArchiveIndexStore(indexPath);
    await store.record(ACCOUNT, [
      { archivedAt: "2026-09-04T00:00:00.000Z", title: "a", url: "https://mp.weixin.qq.com/s/a" }
    ]);
    await store.record("Other==", [
      { archivedAt: "2026-09-04T00:00:00.000Z", title: "b", url: "https://mp.weixin.qq.com/s/b" }
    ]);

    await store.clear(ACCOUNT);
    await expect(store.listArchivedUrls(ACCOUNT)).resolves.toEqual(new Set());
    await expect(store.listArchivedUrls("Other==")).resolves.toHaveProperty("size", 1);

    await store.clear();
    await expect(store.listArchivedUrls("Other==")).resolves.toEqual(new Set());
  });

  test("空数组不会创建或改写索引文件", async () => {
    const store = new ArchiveIndexStore(indexPath);
    await store.record(ACCOUNT, []);

    await expect(readFile(indexPath, "utf8")).rejects.toHaveProperty("code", "ENOENT");
  });
});

describe("normalizeArchiveIndex", () => {
  test("对任意脏数据都产出结构完整的索引", () => {
    expect(normalizeArchiveIndex(null).accounts).toEqual({});
    expect(normalizeArchiveIndex({ accounts: "nope" }).accounts).toEqual({});

    const normalized = normalizeArchiveIndex({
      accounts: { [ACCOUNT]: { articles: { "https://mp.weixin.qq.com/s/a": { title: 42 } } } }
    });

    expect(normalized.accounts[ACCOUNT].articles["https://mp.weixin.qq.com/s/a"]).toMatchObject({
      title: "",
      url: "https://mp.weixin.qq.com/s/a"
    });
  });
});

describe("filterUnarchivedArticles", () => {
  test("按 URL 拆分已归档与未归档，保持原有顺序", () => {
    const { skipped, unarchived } = filterUnarchivedArticles(
      [article("https://mp.weixin.qq.com/s/a"), article("https://mp.weixin.qq.com/s/b"), article("https://mp.weixin.qq.com/s/c")],
      new Set(["https://mp.weixin.qq.com/s/b"])
    );

    expect(unarchived.map((item) => item.url)).toEqual([
      "https://mp.weixin.qq.com/s/a",
      "https://mp.weixin.qq.com/s/c"
    ]);
    expect(skipped.map((item) => item.url)).toEqual(["https://mp.weixin.qq.com/s/b"]);
  });

  test("空索引时全部视为未归档", () => {
    const { skipped, unarchived } = filterUnarchivedArticles(
      [article("https://mp.weixin.qq.com/s/a")],
      new Set()
    );

    expect(unarchived).toHaveLength(1);
    expect(skipped).toHaveLength(0);
  });
});
