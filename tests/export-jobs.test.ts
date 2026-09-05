import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { ExportJobStore, isValidJobId } from "@/lib/export-jobs";

async function makeStore(ttlMs = 60_000) {
  const dir = await mkdtemp(path.join(tmpdir(), "w2f-jobs-"));
  return { dir, store: new ExportJobStore(dir, ttlMs) };
}

describe("isValidJobId", () => {
  test("accepts uuid v4 shape only", () => {
    expect(isValidJobId("3f2504e0-4f89-41d3-9a0c-0305e82c3301")).toBe(true);
    expect(isValidJobId("")).toBe(false);
    expect(isValidJobId("../../etc/passwd")).toBe(false);
    expect(isValidJobId("3f2504e0-4f89-41d3-9a0c")).toBe(false);
  });
});

describe("ExportJobStore", () => {
  test("saves a zip and hands it back once", async () => {
    const { store } = await makeStore();
    const meta = await store.save(Buffer.from("zip-bytes"), "示例-公众号文章.zip");

    expect(isValidJobId(meta.jobId)).toBe(true);

    const first = await store.take(meta.jobId);
    expect(first?.filename).toBe("示例-公众号文章.zip");
    expect(first?.zip.toString()).toBe("zip-bytes");

    // 取走即删，重复领取拿不到内容
    expect(await store.take(meta.jobId)).toBeUndefined();
  });

  test("returns undefined for unknown or malformed ids", async () => {
    const { store } = await makeStore();

    expect(await store.take("3f2504e0-4f89-41d3-9a0c-0305e82c3301")).toBeUndefined();
    expect(await store.take("../secret")).toBeUndefined();
  });

  test("drops jobs older than the ttl instead of serving them", async () => {
    const { store } = await makeStore(-1);
    const meta = await store.save(Buffer.from("stale"), "a.zip");

    expect(await store.take(meta.jobId)).toBeUndefined();
  });

  test("sweep removes expired jobs and keeps foreign files", async () => {
    const { dir, store } = await makeStore(-1);
    await store.save(Buffer.from("stale"), "a.zip");
    await writeFile(path.join(dir, "README.txt"), "keep me", "utf8");

    expect(await store.sweep()).toBe(1);
    expect(await readdir(dir)).toEqual(["README.txt"]);
  });

  test("sweep tolerates a missing directory", async () => {
    const store = new ExportJobStore(
      path.join(tmpdir(), "w2f-jobs-missing-dir-xyz"),
      1000
    );

    expect(await store.sweep()).toBe(0);
  });
});
