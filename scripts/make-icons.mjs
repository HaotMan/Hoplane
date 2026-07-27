// Generates app and tray icons from the root logo.png (opaque white background).
// Usage: node scripts/make-icons.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";

const WHITE_THRESHOLD = 240;

function loadLogo(path) {
  return PNG.sync.read(readFileSync(path));
}

/** Marks every near-white pixel reachable from the image border as background. */
function findBackground(image) {
  const { width, height, data } = image;
  const outside = new Uint8Array(width * height);
  const queue = [];
  const isWhite = (index) => {
    const offset = index * 4;
    return data[offset] >= WHITE_THRESHOLD && data[offset + 1] >= WHITE_THRESHOLD && data[offset + 2] >= WHITE_THRESHOLD;
  };
  const enqueue = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = y * width + x;
    if (outside[index] || !isWhite(index)) return;
    outside[index] = 1;
    queue.push(index);
  };
  for (let x = 0; x < width; x += 1) { enqueue(x, 0); enqueue(x, height - 1); }
  for (let y = 0; y < height; y += 1) { enqueue(0, y); enqueue(width - 1, y); }
  while (queue.length > 0) {
    const index = queue.pop();
    const x = index % width;
    const y = (index - x) / width;
    enqueue(x + 1, y); enqueue(x - 1, y); enqueue(x, y + 1); enqueue(x, y - 1);
  }
  return outside;
}

/** Makes the flood-filled background transparent and crops to the remaining content. */
function extractContent(image) {
  const { width, height, data } = image;
  const outside = findBackground(image);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (outside[index]) {
        data[index * 4 + 3] = 0;
      } else {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error("logo.png appears to be entirely white");
  const cropped = new PNG({ width: maxX - minX + 1, height: maxY - minY + 1 });
  PNG.bitblt(image, cropped, minX, minY, cropped.width, cropped.height, 0, 0);
  return cropped;
}

/** Box-filter downscale (adequate for large shrink ratios), alpha-weighted. */
function resample(source, targetWidth, targetHeight) {
  const target = new PNG({ width: targetWidth, height: targetHeight });
  const xRatio = source.width / targetWidth;
  const yRatio = source.height / targetHeight;
  for (let ty = 0; ty < targetHeight; ty += 1) {
    const yStart = Math.floor(ty * yRatio);
    const yEnd = Math.min(source.height, Math.max(yStart + 1, Math.ceil((ty + 1) * yRatio)));
    for (let tx = 0; tx < targetWidth; tx += 1) {
      const xStart = Math.floor(tx * xRatio);
      const xEnd = Math.min(source.width, Math.max(xStart + 1, Math.ceil((tx + 1) * xRatio)));
      let red = 0, green = 0, blue = 0, alpha = 0, samples = 0;
      for (let sy = yStart; sy < yEnd; sy += 1) {
        for (let sx = xStart; sx < xEnd; sx += 1) {
          const offset = (sy * source.width + sx) * 4;
          const pixelAlpha = source.data[offset + 3];
          red += source.data[offset] * pixelAlpha;
          green += source.data[offset + 1] * pixelAlpha;
          blue += source.data[offset + 2] * pixelAlpha;
          alpha += pixelAlpha;
          samples += 1;
        }
      }
      const targetOffset = (ty * targetWidth + tx) * 4;
      target.data[targetOffset + 3] = Math.round(alpha / samples);
      if (alpha > 0) {
        target.data[targetOffset] = Math.round(red / alpha);
        target.data[targetOffset + 1] = Math.round(green / alpha);
        target.data[targetOffset + 2] = Math.round(blue / alpha);
      }
    }
  }
  return target;
}

/** Centers `content` on a transparent square canvas. */
function compose(content, canvasSize, contentSize) {
  const scale = contentSize / Math.max(content.width, content.height);
  const scaled = resample(content, Math.round(content.width * scale), Math.round(content.height * scale));
  const canvas = new PNG({ width: canvasSize, height: canvasSize });
  PNG.bitblt(scaled, canvas, 0, 0, scaled.width, scaled.height, Math.round((canvasSize - scaled.width) / 2), Math.round((canvasSize - scaled.height) / 2));
  return canvas;
}

const content = extractContent(loadLogo(new URL("../logo.png", import.meta.url).pathname));
const outputs = [
  // macOS icon grid: artwork occupies ~824/1024 of the canvas, rest is margin.
  ["build/icon.png", compose(content, 1024, 824)],
  // Windows icons are full-bleed; the logo shape already has its own rounding.
  ["build/icon-win.png", compose(content, 1024, 1024)],
  ["apps/desktop/electron/tray.png", compose(content, 18, 18)],
  ["apps/desktop/electron/tray@2x.png", compose(content, 36, 36)]
];
for (const [path, image] of outputs) {
  writeFileSync(new URL(`../${path}`, import.meta.url).pathname, PNG.sync.write(image));
  console.log(`wrote ${path} (${image.width}x${image.height})`);
}
