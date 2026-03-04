import sharp from "sharp";
import { log } from "./logger.js";

/**
 * Whether image compression is enabled.
 * Controlled by the IMAGE_COMPRESS_ENABLED environment variable (default: true).
 */
export function isImageCompressEnabled(): boolean {
  const val = process.env["IMAGE_COMPRESS_ENABLED"];
  if (val === undefined || val === "") {
    return true;
  }
  return val.toLowerCase() !== "false" && val !== "0";
}

/**
 * Maximum dimension (width or height) to resize images to when compression is enabled.
 * Controlled by the IMAGE_COMPRESS_MAX_SIZE environment variable (default: 1920).
 */
export function getImageCompressMaxSize(): number {
  const val = process.env["IMAGE_COMPRESS_MAX_SIZE"];
  if (val === undefined || val === "") {
    return 512;
  }
  const parsed = parseInt(val, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 512;
}

/**
 * Compresses an image file in-place using sharp.
 * Resizes the image so that neither dimension exceeds `maxSize` (preserving aspect ratio).
 * The image is always re-encoded in its original format (JPEG, PNG, WebP, etc.).
 * This function works on Windows, Linux, and macOS.
 *
 * @param filePath  Absolute path to the image file to compress.
 * @param maxSize   Maximum width/height in pixels (default: from env / 512).
 */
export async function compressImage(
  filePath: string,
  maxSize: number = getImageCompressMaxSize()
): Promise<void> {
  const image = sharp(filePath);
  const metadata = await image.metadata();

  const { width = 0, height = 0, format } = metadata;

  // Only resize if the image exceeds the maximum dimension.
  if (width > maxSize || height > maxSize) {
    log(`Compressing image: ${filePath} (${width}x${height} -> max ${maxSize}px, format: ${format ?? "unknown"})`);
    const resized = image.resize({
      width: maxSize,
      height: maxSize,
      fit: "inside",
      withoutEnlargement: true,
    });

    // Re-encode in original format to avoid format changes.
    let pipeline: sharp.Sharp;
    switch (format) {
      case "jpeg":
        pipeline = resized.jpeg({ quality: 85 });
        break;
      case "png":
        pipeline = resized.png({ compressionLevel: 7 });
        break;
      case "webp":
        pipeline = resized.webp({ quality: 85 });
        break;
      case "gif":
        // sharp can read GIF frames but cannot write GIF output; convert to WebP
        // to preserve animation support while still reducing dimensions.
        pipeline = resized.webp({ quality: 85 });
        break;
      default:
        // Fall back to JPEG for any unrecognised format (e.g. TIFF, BMP).
        pipeline = resized.jpeg({ quality: 85 });
        break;
    }

    const buffer = await pipeline.toBuffer();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(filePath, buffer);
    log(`Image compressed: ${filePath} (${buffer.byteLength} bytes)`);
  }
}
