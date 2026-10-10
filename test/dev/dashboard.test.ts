import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DASHBOARD_HTML } from '../../src/dev/dashboard';

test('dashboard contains the Tend overview and scenario controls', () => {
  assert.match(DASHBOARD_HTML, /Tend — Household Routine Intelligence/);
  assert.match(DASHBOARD_HTML, /Run scenario/);
  assert.match(DASHBOARD_HTML, /Deviation — sequence change/);
  assert.match(DASHBOARD_HTML, /fetch\("\/demo"/);
  assert.match(DASHBOARD_HTML, /fetch\("\/scenario"/);
});

test('dashboard renders explainable signal and feedback sections', () => {
  assert.match(DASHBOARD_HTML, /Presence/);
  assert.match(DASHBOARD_HTML, /Timing/);
  assert.match(DASHBOARD_HTML, /Sequence/);
  assert.match(DASHBOARD_HTML, /Why this result\?/);
  assert.match(DASHBOARD_HTML, /Caregiver feedback/);
  assert.match(DASHBOARD_HTML, /data-feedback="expected"/);
});

test('dashboard is responsive and returns browser-safe HTML', () => {
  assert.match(DASHBOARD_HTML, /<!doctype html>/i);
  assert.match(DASHBOARD_HTML, /<meta charset="utf-8">/i);
  assert.match(DASHBOARD_HTML, /viewport/);
  assert.match(DASHBOARD_HTML, /max-width: 720px/);
  assert.match(DASHBOARD_HTML, /Activity is simulated, not live household data/);
  assert.match(DASHBOARD_HTML, /Demo date/);
  assert.match(DASHBOARD_HTML, /Explanation: built-in template/);
  assert.match(DASHBOARD_HTML, /What contributed to the result\?/);
});
