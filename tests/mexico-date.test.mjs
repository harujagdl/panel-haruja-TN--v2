import test from 'node:test';
import assert from 'node:assert/strict';
import { getMexicoMonthKey } from '../lib/ventas/mexicoDate.js';

test('31 marzo 10:00 CDMX mantiene monthKey marzo', () => {
  const actual = getMexicoMonthKey('2026-03-31T16:00:00.000Z');
  assert.equal(actual, '2026-03');
});

test('31 marzo 23:59 CDMX mantiene monthKey marzo', () => {
  const actual = getMexicoMonthKey('2026-04-01T05:59:00.000Z');
  assert.equal(actual, '2026-03');
});

test('1 abril 00:01 CDMX cambia monthKey abril', () => {
  const actual = getMexicoMonthKey('2026-04-01T06:01:00.000Z');
  assert.equal(actual, '2026-04');
});
