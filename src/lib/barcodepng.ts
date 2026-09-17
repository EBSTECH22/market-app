import { deflateSync } from "zlib";
import { code128Modules } from "@/lib/code128";

/**
 * A Code 128 barcode as a PNG, with no image library.
 *
 * PNG is two things: a handful of length-tagged chunks with CRCs, and a zlib
 * stream of scanlines. Node ships zlib, so the only thing missing is the CRC —
 * about fifteen lines. A barcode is pure black and white with no anti-aliasing
 * (anti-aliasing is actively harmful: a scanner wants hard edges), so an 8-bit
 * greyscale image of 0x00 and 0xff is all that's needed.
 *
 * PNG rather than SVG because this has to render in an email, and neither Gmail
 * nor Outlook draws SVG.
 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function greyscalePng(width: number, height: number, pixels: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: greyscale
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  /* One filter byte per scanline. Filter 0 (none) throughout: the rows are
     identical runs of two values, which deflate flattens to almost nothing
     anyway, and it keeps this readable. */
  const stride = width + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    pixels.copy(raw, y * stride + 1, y * width, (y + 1) * width);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Render `text` as a Code 128 barcode.
 *
 * `scale` is how many pixels wide one module is. Two is the practical floor for
 * a phone screen; three is comfortable and still narrow enough that a fourteen
 * character code fits across a portrait phone without the browser shrinking it
 * — and a barcode scaled down by a browser is a barcode that doesn't scan.
 */
export function barcodePng(text: string, opts: { scale?: number; height?: number; quiet?: number } = {}): Buffer {
  const scale = Math.max(1, Math.round(opts.scale ?? 3));
  const height = Math.max(20, Math.round(opts.height ?? 150));
  /* Ten modules of white either side. The spec's minimum; without it a scanner
     has no way to measure what a module is and simply refuses to read. */
  const quiet = Math.max(0, Math.round(opts.quiet ?? 10));

  const modules = code128Modules(text);
  const columns = quiet + modules.length + quiet;
  const width = columns * scale;

  const row = Buffer.alloc(width, 0xff);
  for (let i = 0; i < modules.length; i++) {
    if (!modules[i]) continue;
    row.fill(0x00, (quiet + i) * scale, (quiet + i + 1) * scale);
  }

  const pixels = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) row.copy(pixels, y * width);

  return greyscalePng(width, height, pixels);
}
