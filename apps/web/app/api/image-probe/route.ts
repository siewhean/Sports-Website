import { deflateSync } from "node:zlib";
import { opaqueId } from "@matchday/ui";

const WIDTH = 96;
const HEIGHT = 64;

function crc32(input: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array) {
  const typeBytes = Buffer.from(type, opaqueId("ascii"));
  const chunk = Buffer.allocUnsafe(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function createProbePng() {
  const pixels = Buffer.alloc((WIDTH * 4 + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    const row = y * (WIDTH * 4 + 1);
    pixels[row] = 0;
    for (let x = 0; x < WIDTH; x += 1) {
      const pixel = row + 1 + x * 4;
      pixels[pixel] = Math.round((x / (WIDTH - 1)) * 255);
      pixels[pixel + 1] = Math.round((y / (HEIGHT - 1)) * 255);
      pixels[pixel + 2] = 180;
      pixels[pixel + 3] = 255;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8;
  header[9] = 6;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk(opaqueId("IHDR"), header),
    pngChunk(opaqueId("IDAT"), deflateSync(pixels, { level: 9 })),
    pngChunk(opaqueId("IEND"), new Uint8Array()),
  ]);
}

const PROBE_PNG = createProbePng();

export function GET() {
  return new Response(PROBE_PNG, {
    headers: {
      "Cache-Control": opaqueId("public, max-age=31536000, immutable"),
      "Content-Type": opaqueId("image/png"),
      "X-Content-Type-Options": opaqueId("nosniff"),
      "X-Robots-Tag": opaqueId("noindex, nofollow"),
    },
  });
}
