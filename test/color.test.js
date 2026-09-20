import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { nameHsl, rgbToHsl, dominantGarmentColor } from '../src/color.js';

const swatch = (fill, bg = { r: 235, g: 235, b: 235 }) => sharp({ create: { width: 120, height: 160, channels: 3, background: bg } })
  .composite([{ input: { create: { width: 60, height: 100, channels: 3, background: fill } }, left: 30, top: 30 }]).png().toBuffer();

test('nameHsl maps fabric colours sensibly', () => {
  assert.equal(nameHsl(rgbToHsl(20, 20, 22)), 'black');
  assert.equal(nameHsl(rgbToHsl(245, 242, 235)), 'white');
  assert.equal(nameHsl(rgbToHsl(120, 120, 125)), 'grey');
  assert.equal(nameHsl(rgbToHsl(225, 205, 170)), 'beige');
  assert.equal(nameHsl(rgbToHsl(96, 88, 48)), 'green'); // olive
  assert.equal(nameHsl(rgbToHsl(30, 40, 80)), 'navy');
  assert.equal(nameHsl(rgbToHsl(110, 60, 30)), 'brown');
  assert.equal(nameHsl(rgbToHsl(200, 30, 40)), 'red');
  assert.equal(nameHsl(rgbToHsl(240, 170, 190)), 'pink');
});

test('dominantGarmentColor ignores a uniform background and names the garment', async () => {
  assert.equal((await dominantGarmentColor(await swatch({ r: 96, g: 88, b: 48 }))).name, 'green');
  assert.equal((await dominantGarmentColor(await swatch({ r: 25, g: 25, b: 28 }))).name, 'black');
  assert.equal((await dominantGarmentColor(await swatch({ r: 40, g: 50, b: 95 }))).name, 'navy');
  const cream = await dominantGarmentColor(await swatch({ r: 238, g: 230, b: 210 }, { r: 90, g: 70, b: 50 }));
  assert.ok(['beige', 'white'].includes(cream.name), cream.name);
  const black = await dominantGarmentColor(await swatch({ r: 25, g: 25, b: 28 }));
  assert.ok(black.share > 0.9);
});
