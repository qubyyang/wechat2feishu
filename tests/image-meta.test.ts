import { describe, expect, test } from "vitest";

import { fitImageWidth, indexAssetsByPath, probeImage } from "@/lib/image-meta";
import type { ArticleAsset } from "@/lib/types";

/** 构造最小合法文件头，避免测试依赖真实图片素材 */
function pngBytes(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);

  return buffer;
}

function gifBytes(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(10);
  buffer.write("GIF89a", 0, "ascii");
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);

  return buffer;
}

function bmpBytes(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(26);
  buffer.write("BM", 0, "ascii");
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);

  return buffer;
}

function jpgBytes(width: number, height: number, extraSegments = true): Buffer {
  const chunks: Buffer[] = [Buffer.from([0xff, 0xd8])];

  if (extraSegments) {
    // 先塞一个 APP0(ffe0) 段，确保解析器会正确跳段而不是撞上第一个 marker 就读
    const app0 = Buffer.alloc(4 + 14);
    app0.writeUInt16BE(0xffe0, 0);
    app0.writeUInt16BE(16, 2);
    chunks.push(app0);
  }

  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(9, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  chunks.push(sof);

  return Buffer.concat(chunks);
}

describe("probeImage", () => {
  test("reads dimensions for every docx-compatible format", () => {
    expect(probeImage(pngBytes(800, 400))).toEqual({ height: 400, type: "png", width: 800 });
    expect(probeImage(gifBytes(120, 90))).toEqual({ height: 90, type: "gif", width: 120 });
    expect(probeImage(bmpBytes(64, 48))).toEqual({ height: 48, type: "bmp", width: 64 });
    expect(probeImage(jpgBytes(500, 300))).toEqual({ height: 300, type: "jpg", width: 500 });
  });

  test("walks past leading jpeg segments to find the SOF marker", () => {
    expect(probeImage(jpgBytes(1024, 768, true))?.width).toBe(1024);
    expect(probeImage(jpgBytes(1024, 768, false))?.width).toBe(1024);
  });

  test("treats a negative bmp height as top-down storage", () => {
    expect(probeImage(bmpBytes(64, -48))).toEqual({ height: 48, type: "bmp", width: 64 });
  });

  test("returns undefined for formats docx cannot embed", () => {
    // webp：RIFF 容器，docx 不支持
    expect(probeImage(Buffer.from("RIFF____WEBPVP8 ", "ascii"))).toBeUndefined();
    // svg：文本
    expect(probeImage(Buffer.from("<svg xmlns='...'></svg>", "utf8"))).toBeUndefined();
    expect(probeImage(Buffer.alloc(0))).toBeUndefined();
    expect(probeImage(Buffer.from([0xff, 0xd8]))).toBeUndefined();
  });

  test("rejects absurd dimensions rather than emitting a broken docx", () => {
    expect(probeImage(pngBytes(0, 100))).toBeUndefined();
    expect(probeImage(pngBytes(50_000, 100))).toBeUndefined();
  });
});

describe("fitImageWidth", () => {
  test("scales oversized images down and keeps the aspect ratio", () => {
    expect(fitImageWidth({ height: 400, type: "png", width: 800 }, 600)).toEqual({
      height: 300,
      width: 600
    });
  });

  test("never upscales a small image", () => {
    expect(fitImageWidth({ height: 40, type: "png", width: 80 }, 600)).toEqual({
      height: 40,
      width: 80
    });
  });

  test("keeps at least one pixel of height for extreme banners", () => {
    expect(fitImageWidth({ height: 1, type: "png", width: 4000 }, 600).height).toBe(1);
  });
});

describe("indexAssetsByPath", () => {
  test("resolves an asset by zip path, relative path and original url", () => {
    const asset: ArticleAsset = {
      data: pngBytes(10, 10),
      kind: "image",
      path: "assets/abc.png",
      sourceUrl: "https://mmbiz.qpic.cn/abc"
    };
    const index = indexAssetsByPath([asset]);

    expect(index.get("assets/abc.png")).toBe(asset);
    expect(index.get("./assets/abc.png")).toBe(asset);
    expect(index.get("https://mmbiz.qpic.cn/abc")).toBe(asset);
    expect(index.get("assets/missing.png")).toBeUndefined();
  });
});
