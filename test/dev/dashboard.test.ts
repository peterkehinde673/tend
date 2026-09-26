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
  assert.match(DASHBOARD_HTML, /Explainable reasoning/);
  assert.match(DASHBOARD_HTML, /Caregiver feedback/);
  assert.match(DASHBOARD_HTML, /data-feedback="expected"/);
});

test('dashboard is responsive and uses a browser-safe HTML response', () => {
  assert.match(DASHBOARD_HTML, /viewport/);
  assert.match(DASHBOARD_HTML, /max-width: 720px/);
  assert.match(DASHBOARD_HTML, /text\/html/);
});
