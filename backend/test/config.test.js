'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildConfig } = require('../src/config');

test('honours XDG_DATA_HOME for session storage', () => {
  const c = buildConfig({ XDG_DATA_HOME: '/xdg/data', XDG_RUNTIME_DIR: '/run/user/9' }, '/home/u', 9);
  assert.strictEqual(c.sessionDir, '/xdg/data/whatsapp-widget/session');
});

test('falls back to ~/.local/share when XDG_DATA_HOME is unset', () => {
  const c = buildConfig({ XDG_RUNTIME_DIR: '/run/user/9' }, '/home/u', 9);
  assert.strictEqual(c.sessionDir, '/home/u/.local/share/whatsapp-widget/session');
});

test('derives the runtime dir from uid when XDG_RUNTIME_DIR is unset', () => {
  const c = buildConfig({}, '/home/u', 9);
  assert.strictEqual(c.endpointFile, '/run/user/9/whatsapp-widget-endpoint.json');
});

test('pins the dedicated PAM service name and store bounds', () => {
  const c = buildConfig({}, '/home/u', 9);
  assert.strictEqual(c.pamService, 'whatsapp-widget');
  assert.strictEqual(c.maxMessagesPerChat, 50);
  assert.strictEqual(c.maxChats, 200);
});
