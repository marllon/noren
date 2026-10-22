import { inflateSync } from "node:zlib";

// A reader of the pixels of a PNG, for the tests that need to see what the page really painted (a
// terminal that lets a picture through is a fact about pixels, not about styles). It reads what
// Playwright writes: 8 bits per channel, RGB or RGBA, not interlaced. Nothing else is accepted.

export interface Pixels {
  width: number;
  height: number;
  /** The color of a pixel, `[r, g, b]`, from the top left corner. */
  at(x: number, y: number): [number, number, number];
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function readPixels(png: Buffer): Pixels {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const color = body[9];
      const interlace = body[12];
      if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0) {
        throw new Error(`unsupported PNG (depth ${depth}, color ${color}, interlace ${interlace})`);
      }
      channels = color === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      data.push(body);
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x] ?? 0;
      const left = x >= channels ? (out[y * stride + x - channels] ?? 0) : 0;
      const up = y > 0 ? (out[(y - 1) * stride + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= channels ? (out[(y - 1) * stride + x - channels] ?? 0) : 0;
      let add = 0;
      if (filter === 1) add = left;
      else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) add = paeth(left, up, upLeft);
      out[y * stride + x] = (value + add) & 0xff;
    }
  }
  return {
    width,
    height,
    at(x, y) {
      const start = y * stride + x * channels;
      return [out[start] ?? 0, out[start + 1] ?? 0, out[start + 2] ?? 0];
    },
  };
}
