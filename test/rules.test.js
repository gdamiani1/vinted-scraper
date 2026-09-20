import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRules, brandTier, parseSize, sizeDesirability, categoryLiquidity, buyScore, fitsMySize, genderOf, listingAgeDays } from '../src/rules.js';

const rules = loadRules();

test('brandTier recognises luxury brands case/diacritic-insensitively', () => {
  assert.equal(brandTier('Chanel', rules), 'tier1');
  assert.equal(brandTier('hermes', rules), 'tier1');
  assert.equal(brandTier('Maison Margiela', rules), 'tier1');
  assert.equal(brandTier('Nike', rules), 'other');
  assert.equal(brandTier('Sandro', rules), 'tier2');
  assert.equal(brandTier('COS', rules), 'tier3');
  assert.equal(brandTier('Loro Piana', rules), 'tier1');
  assert.equal(brandTier(undefined, rules), 'other');
});

test('parseSize extracts letter and EU numeric sizes from Vinted strings', () => {
  assert.deepEqual(parseSize('S / 36 / 8'), { letter: 'S', eu: 36 });
  assert.deepEqual(parseSize('XXXL'), { letter: 'XXXL', eu: undefined });
  assert.deepEqual(parseSize('42,5'), { letter: undefined, eu: 42.5 });
  assert.deepEqual(parseSize('M'), { letter: 'M', eu: undefined });
  assert.deepEqual(parseSize(''), { letter: undefined, eu: undefined });
});

test('sizeDesirability follows the rules: Chanel XXXL is not a buy, M is', () => {
  assert.ok(sizeDesirability('XXXL', 'outerwear', rules) <= 0.1);
  assert.equal(sizeDesirability('M', 'outerwear', rules), 1);
  assert.equal(sizeDesirability('S / 36 / 8', 'dress', rules), 1);
  assert.ok(sizeDesirability('46', 'trousers', rules) < 0.3);
  assert.equal(sizeDesirability('38', 'shoes', rules), 1);
  assert.ok(sizeDesirability('35', 'shoes', rules) < 0.6);
  assert.equal(sizeDesirability(undefined, 'bag', rules), 1); // bags have no size
  assert.ok(sizeDesirability(undefined, 'dress', rules) < 1); // unknown size on clothing is a penalty
});

test('categoryLiquidity prefers bags and shoes over tops', () => {
  assert.ok(categoryLiquidity('bag', rules) > categoryLiquidity('shoes', rules));
  assert.ok(categoryLiquidity('shoes', rules) > categoryLiquidity('top', rules));
  assert.equal(categoryLiquidity('nonsense', rules), rules.categories.other);
});

test('buyScore combines margin, sellability and verdict confidence with reasons', () => {
  const item = { id: 1, title: 'Chanel classic flap', brand: 'Chanel', size: undefined, price: 1500, currency: 'EUR', totalPrice: 1580, conditionId: 2 };
  const verdict = { item_type: 'bag', authenticity_risk: 'low', condition_grade: 'very_good', resale_estimate_eur: { low: 2800, high: 3400 }, confidence: 0.8, red_flags: [] };
  const good = buyScore(item, { verdict, rules });
  assert.ok(good.score >= 70, `score ${good.score}`);
  assert.ok(good.margin > 700);
  assert.equal(good.resaleEstimate, 3100);
  assert.ok(good.reasons.some((r) => /margin/i.test(r)));

  const xxxl = buyScore({ ...item, title: 'Chanel jacket', size: 'XXXL' }, { verdict: { ...verdict, item_type: 'outerwear' }, rules });
  assert.ok(xxxl.score < 25, `score ${xxxl.score}`);
  assert.ok(xxxl.reasons.some((r) => /size/i.test(r)));

  const fake = buyScore(item, { verdict: { ...verdict, authenticity_risk: 'high' }, rules });
  assert.equal(fake.score, 0);
  assert.ok(fake.reasons.some((r) => /authenticity/i.test(r)));

  const noVerdict = buyScore(item, { rules, comparables: [2900, 3000, 3200, 3100, 2800] });
  assert.equal(noVerdict.resaleEstimate, 3000);
  assert.ok(noVerdict.score > 0 && noVerdict.score < good.score);
});

test('isCandidate drops packaging, samples and suspiciously cheap luxury listings', async () => {
  const { isCandidate } = await import('../src/buyer.js');
  assert.equal(isCandidate({ title: 'Chanel Tragetasche Tüte', brand: 'Chanel', price: 10 }, rules), false);
  assert.equal(isCandidate({ title: 'Chanel Classic Flap', brand: 'Chanel', price: 1500 }, rules), true);
  assert.equal(isCandidate({ title: 'Chanel earrings', brand: 'Chanel', price: 40 }, rules), false);
  assert.equal(isCandidate({ title: 'Sandro blazer', brand: 'Sandro', price: 40 }, rules), true);
  assert.equal(isCandidate({ title: 'COS coat', brand: 'COS', price: 20 }, rules), true);
  assert.equal(isCandidate({ title: 'Nike Air Max', brand: 'Nike', price: 40 }, rules), false);
  assert.equal(isCandidate({ title: 'Nike Air Max', brand: 'Nike', price: 40 }, rules, { luxuryOnly: false }), true);
});

test('fitsMySize matches EU 45-46 shoes, L/XL clothing, W34 trousers and unsized categories', () => {
  const my = { mySizes: { shoesEu: [44.5, 45, 45.5, 46], shoesCm: [29.5], clothing: ['L', 'XL'], clothingEu: [50, 52], waist: [34], inseam: [34] } };
  const fit = (size, type) => fitsMySize({ size }, my, type);
  assert.equal(fit('45', 'shoes'), true);
  assert.equal(fit('45,5', 'shoes'), true);
  assert.equal(fit('42', 'shoes'), false);
  assert.equal(fit('29.5 cm'), true);
  assert.equal(fit('L / 40 / 12', 'outerwear'), true);
  assert.equal(fit('XL'), true);
  assert.equal(fit('M', 'knitwear'), false);
  assert.equal(fit('52', 'outerwear'), true);
  assert.equal(fit('W34 L34'), true);
  assert.equal(fit('W32 L34'), false);
  assert.equal(fit('34/34'), true);
  assert.equal(fit('34', 'trousers'), true);
  assert.equal(fit(undefined, 'bag'), true);
  assert.equal(fit(undefined, 'shoes'), false);
  assert.equal(fit('45'), true);
  assert.equal(fit('38'), false);
});

test('genderOf reads verdict, breadcrumbs, then title words; fitsMySize drops women\'s pieces for a men profile', () => {
  assert.equal(genderOf({ verdict: { gender: 'women' } }), 'women');
  assert.equal(genderOf({ detail: { breadcrumbs: ['Damen', 'Taschen'] } }), 'women');
  assert.equal(genderOf({ detail: { breadcrumbs: ['Muškarci', 'Obuća'] } }), 'men');
  assert.equal(genderOf({ title: 'Prada Herren Sneaker' }), 'men');
  assert.equal(genderOf({ title: 'Tacchi Miu Miu donna' }), 'women');
  assert.equal(genderOf({ title: 'Loewe Puzzle bag' }), 'unknown');
  const my = { mySizes: { gender: 'men', shoesEu: [45], clothing: ['L'], clothingEu: [50, 52], waist: [34], inseam: [34] } };
  assert.equal(fitsMySize({ size: undefined, detail: { breadcrumbs: ['Damen', 'Taschen'] } }, my, 'bag'), false);
  assert.equal(fitsMySize({ size: undefined, detail: { breadcrumbs: ['Herren', 'Taschen'] } }, my, 'bag'), true);
  assert.equal(fitsMySize({ size: '45', title: 'Damen Sneaker' }, my, 'shoes'), false);
  assert.equal(fitsMySize({ size: '45', title: 'Sneaker' }, my, 'shoes'), true);
});

test('listingAgeDays parses relative ages in several languages; stale listings and new sellers lower the buy score', () => {
  assert.equal(listingAgeDays('vor 8 Monaten'), 240);
  assert.equal(listingAgeDays('prije 2 min') < 0.01, true);
  assert.equal(listingAgeDays('7 h'), 7 / 24);
  assert.equal(listingAgeDays('3 days ago'), 3);
  assert.equal(listingAgeDays('il y a 2 semaines'), 14);
  assert.equal(listingAgeDays('prije 3 tjedna'), 21);
  assert.equal(listingAgeDays(undefined), undefined);
  const item = { id: 1, title: 'Chanel classic flap', brand: 'Chanel', price: 1500, currency: 'EUR', totalPrice: 1580, conditionId: 2 };
  const verdict = { item_type: 'bag', authenticity_risk: 'low', condition_grade: 'very_good', resale_estimate_eur: { low: 2800, high: 3400 }, confidence: 0.8, red_flags: [] };
  const fresh = buyScore(item, { verdict, rules }).score;
  const stale = buyScore({ ...item, detail: { uploadedAgo: 'vor 8 Monaten' } }, { verdict, rules });
  const newbie = buyScore({ ...item, detail: { seller: { feedbackCount: 1 } } }, { verdict, rules });
  assert.ok(stale.score < fresh * 0.5, `${stale.score} vs ${fresh}`);
  assert.ok(stale.reasons.some((x) => /months ago/.test(x)));
  assert.ok(newbie.score < fresh * 0.7);
  assert.ok(newbie.reasons.some((x) => /reviews/.test(x)));
});

test('buyScore counts shipping from the item page in the all-in cost', () => {
  const item = { id: 1, title: 'Loewe bag', brand: 'Loewe', price: 100, currency: 'EUR', buyerPrice: 106, conditionId: 2 };
  const verdict = { item_type: 'bag', authenticity_risk: 'low', condition_grade: 'very_good', resale_estimate_eur: { low: 250, high: 250 }, confidence: 0.9, red_flags: [] };
  const noShip = buyScore(item, { verdict, rules });
  const ship = buyScore({ ...item, detail: { shipping: { price: 12 } } }, { verdict, rules });
  assert.equal(noShip.costAllIn, 106);
  assert.equal(ship.costAllIn, 118);
  assert.equal(noShip.margin - ship.margin, 12);
  assert.ok(ship.reasons[0].includes('incl. 12 shipping'));
});
