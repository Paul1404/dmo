import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const root = new URL("..", import.meta.url).pathname;
const publicDir = join(root, "public");
const svgPath = join(publicDir, "favicon.svg");

await mkdir(publicDir, { recursive: true });
const svg = await readFile(svgPath);

const pngSizes: Array<{ name: string; size: number }> = [
  { name: "favicon-16.png", size: 16 },
  { name: "favicon-32.png", size: 32 },
  { name: "favicon-48.png", size: 48 },
  { name: "apple-touch-icon.png", size: 180 },
  { name: "icon-192.png", size: 192 },
  { name: "icon-512.png", size: 512 },
];

const renders: Record<number, Buffer> = {};
for (const { name, size } of pngSizes) {
  const buf = await sharp(svg).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
  await writeFile(join(publicDir, name), buf);
  renders[size] = buf;
  console.log(`wrote public/${name} (${size}x${size}, ${buf.length} bytes)`);
}

const icoSizes = [16, 32, 48];
const ico = buildIco(icoSizes.map((s) => ({ size: s, png: renders[s] })));
await writeFile(join(publicDir, "favicon.ico"), ico);
console.log(`wrote public/favicon.ico (${icoSizes.join(",")}, ${ico.length} bytes)`);

function buildIco(images: Array<{ size: number; png: Buffer }>): Buffer {
  const headerSize = 6;
  const entrySize = 16;
  const directorySize = headerSize + entrySize * images.length;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const entries: Buffer[] = [];
  const payloads: Buffer[] = [];
  let offset = directorySize;

  for (const { size, png } of images) {
    const entry = Buffer.alloc(entrySize);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    payloads.push(png);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...payloads]);
}
