import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 流式导出把 ZIP 交付拆成两次请求：SSE 连接只能传文本，二进制必须落盘暂存，
 * 再由前端凭 jobId 走普通下载。任务放磁盘而不是内存，是为了让 dev 模式的模块
 * 热重载和多 worker 部署都不会把已完成的包弄丢。
 */
export type ExportJobMeta = {
  createdAt: number;
  filename: string;
  jobId: string;
};

const META_SUFFIX = ".json";
const ZIP_SUFFIX = ".zip";

/** jobId 会拼进文件路径，必须严格限制字符集以杜绝路径穿越 */
export function isValidJobId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export class ExportJobStore {
  private readonly dir: string;
  private readonly ttlMs: number;

  constructor(dir: string, ttlMs: number) {
    this.dir = path.resolve(process.cwd(), dir);
    this.ttlMs = ttlMs;
  }

  async save(zip: Buffer, filename: string): Promise<ExportJobMeta> {
    await mkdir(this.dir, { recursive: true });

    const meta: ExportJobMeta = {
      createdAt: Date.now(),
      filename,
      jobId: randomUUID()
    };

    await writeFile(this.zipPath(meta.jobId), zip);
    await writeFile(this.metaPath(meta.jobId), JSON.stringify(meta), "utf8");

    return meta;
  }

  /** 取出并立即删除：ZIP 只需要被下载一次，留着只会堆积磁盘 */
  async take(jobId: string): Promise<{ filename: string; zip: Buffer } | undefined> {
    if (!isValidJobId(jobId)) return undefined;

    let meta: ExportJobMeta;
    let zip: Buffer;

    try {
      meta = JSON.parse(await readFile(this.metaPath(jobId), "utf8")) as ExportJobMeta;
      zip = await readFile(this.zipPath(jobId));
    } catch {
      return undefined;
    }

    if (Date.now() - meta.createdAt > this.ttlMs) {
      await this.remove(jobId);
      return undefined;
    }

    await this.remove(jobId);

    return { filename: meta.filename, zip };
  }

  /** 清理过期残留。下载失败或用户关页面时任务会留在磁盘上，需要兜底回收 */
  async sweep(): Promise<number> {
    let removed = 0;

    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return 0;
    }

    for (const entry of entries) {
      if (!entry.endsWith(ZIP_SUFFIX)) continue;

      const jobId = entry.slice(0, -ZIP_SUFFIX.length);
      if (!isValidJobId(jobId)) continue;

      try {
        const info = await stat(path.join(this.dir, entry));
        if (Date.now() - info.mtimeMs <= this.ttlMs) continue;
      } catch {
        continue;
      }

      await this.remove(jobId);
      removed += 1;
    }

    return removed;
  }

  private metaPath(jobId: string): string {
    return path.join(this.dir, `${jobId}${META_SUFFIX}`);
  }

  private async remove(jobId: string): Promise<void> {
    await Promise.all([
      unlink(this.zipPath(jobId)).catch(() => undefined),
      unlink(this.metaPath(jobId)).catch(() => undefined)
    ]);
  }

  private zipPath(jobId: string): string {
    return path.join(this.dir, `${jobId}${ZIP_SUFFIX}`);
  }
}
