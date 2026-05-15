import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { TransferHistoryInput, TransferHistoryRecord } from "./types";

export class HistoryStore {
  private readonly filePath: string;

  constructor(filePath = process.env.W2F_HISTORY_PATH ?? "./data/history.json") {
    this.filePath = resolve(filePath);
  }

  async add(input: TransferHistoryInput): Promise<TransferHistoryRecord> {
    const records = await this.list();
    const record: TransferHistoryRecord = {
      ...input,
      createdAt: new Date().toISOString(),
      id: randomUUID()
    };

    await this.write([record, ...records].slice(0, 100));
    return record;
  }

  async clear(): Promise<void> {
    await this.write([]);
  }

  async list(): Promise<TransferHistoryRecord[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  private async write(records: TransferHistoryRecord[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  }
}
