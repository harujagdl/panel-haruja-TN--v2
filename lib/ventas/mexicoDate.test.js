import test from 'node:test';
import assert from 'node:assert/strict';

import { getMexicoMonthKey } from './mexicoDate.js';

test('31 marzo 10:00 CDMX permanece en marzo', () => {
  assert.equal(getMexicoMonthKey('2026-03-31T16:00:00.000Z'), '2026-03');
});

test('31 marzo 23:59 CDMX permanece en marzo', () => {
  assert.equal(getMexicoMonthKey('2026-04-01T05:59:00.000Z'), '2026-03');
});

test('1 abril 00:01 CDMX cambia a abril', () => {
  assert.equal(getMexicoMonthKey('2026-04-01T06:01:00.000Z'), '2026-04');
});
