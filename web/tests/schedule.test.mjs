// Viewing-time rules (src/shared/schedule.ts). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

// load the TypeScript module without a build step
const src = readFileSync(new URL('../src/shared/schedule.ts', import.meta.url), 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', transformSync(src, { loader: 'ts', format: 'cjs' }).code)(mod, mod.exports);
const { isAllowed, describeWindow, describeShort, validWindow, dayPartEmoji } = mod.exports;

// 2026-10-18 is a Sunday (day 0)
const at = (day, h, m) => new Date(2026, 9, 18 + day, h, m);
const W = (from, to, days) => (days ? { from, to, days } : { from, to });

test('no windows = always available', () => {
  assert.equal(isAllowed(undefined, at(0, 3, 0)), true);
  assert.equal(isAllowed([], at(0, 3, 0)), true);
});

test('start is inclusive, end is exclusive', () => {
  const w = [W('16:00', '19:00')];
  assert.equal(isAllowed(w, at(2, 15, 59)), false);
  assert.equal(isAllowed(w, at(2, 16, 0)), true);
  assert.equal(isAllowed(w, at(2, 18, 59)), true);
  assert.equal(isAllowed(w, at(2, 19, 0)), false);
});

test('day filter', () => {
  const w = [W('16:00', '19:00', [5, 6])];                 // Friday + Saturday
  assert.equal(isAllowed(w, at(5, 17, 0)), true);
  assert.equal(isAllowed(w, at(2, 17, 0)), false);
});

test('overnight window: the morning part belongs to the start day', () => {
  assert.equal(isAllowed([W('22:00', '02:00')], at(2, 23, 0)), true);
  assert.equal(isAllowed([W('22:00', '02:00')], at(3, 1, 0)), true);
  assert.equal(isAllowed([W('22:00', '02:00')], at(3, 2, 0)), false);
  const thu = [W('22:00', '02:00', [4])];
  assert.equal(isAllowed(thu, at(5, 1, 0)), true);          // Friday 01:00 = Thursday night
  assert.equal(isAllowed(thu, at(6, 1, 0)), false);
});

test('several windows', () => {
  const w = [W('08:00', '10:00'), W('16:00', '18:00')];
  assert.equal(isAllowed(w, at(1, 9, 0)), true);
  assert.equal(isAllowed(w, at(1, 12, 0)), false);
  assert.equal(isAllowed(w, at(1, 17, 0)), true);
});

test('invalid windows are ignored', () => {
  assert.equal(validWindow(W('', '19:00')), false);
  assert.equal(validWindow(W('10:00', '10:00')), false);
  assert.equal(isAllowed([W('', '19:00')], at(2, 3, 0)), true);
});

test('Arabic descriptions', () => {
  assert.equal(describeWindow(W('16:00', '19:30', [5, 6])), '4:00 م – 7:30 م (جمعة، سبت)');
  assert.equal(describeShort([W('08:00', '14:00'), W('16:00', '18:00')]), '⏰ 8:00 ص – 2:00 م …');
});

test('day-part picture for children (UX-AUDIT K7)', () => {
  assert.equal(dayPartEmoji(undefined), '');
  assert.equal(dayPartEmoji([W('08:00', '14:00')]), '🌅');
  assert.equal(dayPartEmoji([W('13:00', '15:00')]), '☀️');
  assert.equal(dayPartEmoji([W('18:00', '20:00')]), '🌇');
  assert.equal(dayPartEmoji([W('20:00', '06:00')]), '🌙');
  assert.equal(dayPartEmoji([W('03:00', '04:00')]), '🌙');
});