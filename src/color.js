/**
 * Garment colour from pixels, not from a neural net: crop the centre of the listing photo, discard
 * pixels that match the border (background), and name the dominant remaining colour by hue,
 * saturation and lightness. Deterministic, ~5 ms per image with sharp.
 */
import sharp from 'sharp';

export const COLOR_NAMES = ['black', 'white', 'grey', 'beige', 'brown', 'navy', 'blue', 'green', 'red', 'pink', 'purple', 'yellow', 'orange', 'multicolour'];

export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
}

/** Names one colour from HSL. Uses chroma (max-min) rather than saturation so off-whites and dark greys stay achromatic. */
export function nameHsl({ h, s, l }) {
  const c = s * (1 - Math.abs(2 * l - 1)); // chroma
  if (l < 0.16) return 'black';
  if (l > 0.86 && c < 0.14) return 'white';
  if (c < 0.07) return l > 0.75 ? 'white' : l < 0.28 ? 'black' : 'grey';
  if (c < 0.2 && l > 0.6 && h >= 20 && h <= 75) return 'beige';
  if (c < 0.11) return 'grey';
  if (h < 12 || h >= 340) return l > 0.72 ? 'pink' : 'red';
  if (h < 45) return l > 0.7 && c < 0.45 ? 'beige' : l < 0.45 ? 'brown' : 'orange';
  if (h < 75) return l > 0.65 && c < 0.45 ? 'beige' : l < 0.5 ? 'green' : 'yellow'; // olive / khaki live here
  if (h < 170) return 'green';
  if (h < 200) return l < 0.35 ? 'navy' : 'blue';
  if (h < 255) return l < 0.32 ? 'navy' : 'blue';
  if (h < 300) return 'purple';
  return l > 0.6 ? 'pink' : 'purple';
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * @param {Buffer} imageBuffer any format sharp reads (webp, jpeg, png)
 * @returns {{ name: string, hex: string, share: number, second?: string }} share = fraction of foreground pixels in the winning colour bucket
 */
export async function dominantGarmentColor(imageBuffer, { size = 48 } = {}) {
  const { data, info } = await sharp(imageBuffer).resize(size, size, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => { const i = (y * info.width + x) * 3; return [data[i], data[i + 1], data[i + 2]]; };
  // background = average of border pixels
  const border = [];
  for (let x = 0; x < size; x++) { border.push(px(x, 0), px(x, size - 1)); }
  for (let y = 1; y < size - 1; y++) { border.push(px(0, y), px(size - 1, y)); }
  const bg = border.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]).map((v) => v / border.length);
  const bgSpread = border.reduce((s, p) => s + dist(p, bg), 0) / border.length;
  const uniformBg = bgSpread < 40; // plain wall/floor: safe to subtract
  // foreground = centre 60% minus background-coloured pixels
  const lo = Math.round(size * 0.2), hi = Math.round(size * 0.8);
  const buckets = new Map();
  let fg = 0;
  const sum = [0, 0, 0];
  for (let y = lo; y < hi; y++) for (let x = lo; x < hi; x++) {
    const p = px(x, y);
    if (uniformBg && dist(p, bg) < 45) continue;
    fg++;
    const name = nameHsl(rgbToHsl(...p));
    const b = buckets.get(name) ?? { n: 0, sum: [0, 0, 0] };
    b.n++; b.sum[0] += p[0]; b.sum[1] += p[1]; b.sum[2] += p[2];
    buckets.set(name, b);
    sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2];
  }
  if (!fg) { // garment is the same colour as the background (white on white): fall back to the centre average
    const p = px(size >> 1, size >> 1);
    return { name: nameHsl(rgbToHsl(...p)), hex: toHex(p), share: 1 };
  }
  const ranked = [...buckets.entries()].sort((a, b) => b[1].n - a[1].n);
  const [name, top] = ranked[0];
  const share = top.n / fg;
  const hex = toHex(top.sum.map((v) => v / top.n));
  const second = ranked[1] && ranked[1][1].n / fg > 0.25 ? ranked[1][0] : undefined;
  return { name: share < 0.34 && ranked.length >= 3 ? 'multicolour' : name, hex, share: Number(share.toFixed(2)), second };
}

const toHex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
