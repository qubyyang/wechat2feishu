import type { ArticleAsset } from "./types";

/** docx 的 ImageRun 只认这四种位图格式，其余（svg/webp 等）无法内嵌 */
export type DocxImageType = "bmp" | "gif" | "jpg" | "png";

export type ImageMeta = {
  height: number;
  type: DocxImageType;
  width: number;
};

const MAX_DIMENSION = 20_000;

/**
 * 从图片字节里读出格式与像素尺寸。
 *
 * DOCX 的 ImageRun 要求显式给出 transformation 宽高，拿不到真实尺寸就只能瞎猜，
 * 图片会被拉伸变形。这里直接解析文件头，避免为了读个宽高再引入 image-size 之类
 * 的依赖——需要支持的四种格式头部结构都很简单。
 */
export function probeImage(data: Buffer): ImageMeta | undefined {
  const meta = probePng(data) ?? probeGif(data) ?? probeBmp(data) ?? probeJpg(data);

  if (!meta) return undefined;
  // 解析错位时会读出荒谬的尺寸，宁可跳过这张图也不要产出损坏的 DOCX
  if (meta.width <= 0 || meta.height <= 0) return undefined;
  if (meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION) return undefined;

  return meta;
}

function probePng(data: Buffer): ImageMeta | undefined {
  // signature(8) + IHDR length/type(8) + width(4) + height(4)
  if (data.length < 24) return undefined;
  if (data.readUInt32BE(0) !== 0x89504e47) return undefined;

  return { height: data.readUInt32BE(20), type: "png", width: data.readUInt32BE(16) };
}

function probeGif(data: Buffer): ImageMeta | undefined {
  if (data.length < 10) return undefined;
  if (data.toString("ascii", 0, 3) !== "GIF") return undefined;

  return { height: data.readUInt16LE(8), type: "gif", width: data.readUInt16LE(6) };
}

function probeBmp(data: Buffer): ImageMeta | undefined {
  if (data.length < 26) return undefined;
  if (data.toString("ascii", 0, 2) !== "BM") return undefined;

  // BMP 高度可能为负，表示自上而下存储，取绝对值
  return {
    height: Math.abs(data.readInt32LE(22)),
    type: "bmp",
    width: Math.abs(data.readInt32LE(18))
  };
}

/** JPEG 要顺着 marker 链走到 SOFn 段才能拿到尺寸 */
function probeJpg(data: Buffer): ImageMeta | undefined {
  if (data.length < 4) return undefined;
  if (data.readUInt16BE(0) !== 0xffd8) return undefined;

  let offset = 2;

  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = data[offset + 1];

    // 填充字节与无载荷的独立 marker，直接跳过
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === undefined || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }

    const length = data.readUInt16BE(offset + 2);
    if (length < 2) return undefined;

    // SOF0..SOF15，排除 DHT(c4) / JPGA(c8) / DAC(cc) 这三个非 SOF 段
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isSof) {
      return {
        height: data.readUInt16BE(offset + 5),
        type: "jpg",
        width: data.readUInt16BE(offset + 7)
      };
    }

    offset += 2 + length;
  }

  return undefined;
}

/**
 * 按最大宽度等比缩放。
 *
 * 公众号配图动辄上千像素宽，原样塞进 A4 正文会溢出页面。这里只缩不放：
 * 小图保持原尺寸，免得把表情包拉伸成马赛克。
 */
export function fitImageWidth(
  meta: ImageMeta,
  maxWidth: number
): { height: number; width: number } {
  if (meta.width <= maxWidth) return { height: meta.height, width: meta.width };

  const ratio = maxWidth / meta.width;

  return { height: Math.max(1, Math.round(meta.height * ratio)), width: maxWidth };
}

/** 按 ZIP 内相对路径建索引，供正文里的 ./assets/xxx 引用回查 */
export function indexAssetsByPath(assets: ArticleAsset[]): Map<string, ArticleAsset> {
  const index = new Map<string, ArticleAsset>();

  for (const asset of assets) {
    index.set(asset.path, asset);
    index.set(`./${asset.path}`, asset);
    // 正文改写前可能仍是远程地址，一并可查
    index.set(asset.sourceUrl, asset);
  }

  return index;
}
