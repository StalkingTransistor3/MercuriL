const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword, safeNext, normalizeUsername } = require('../lib/auth');

test('password hashes use unique salts and reject incorrect or malformed credentials', async () => {
  const password = 'isolated-test-passphrase';
  const first = await hashPassword(password), second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword('wrong password', first), false);
  assert.equal(await verifyPassword(password, 'broken'), false);
  assert.equal(await verifyPassword({ password }, first), false);
  await assert.rejects(hashPassword('short'));
});

test('return links preserve local deep links and reject external redirects', () => {
  assert.equal(safeNext('/?device=mercuril-01'), '/?device=mercuril-01');
  assert.equal(safeNext('/telemetry?device=mercuril-01#plot'), '/telemetry?device=mercuril-01#plot');
  for (const value of ['https://evil.example', '//evil.example', '/\\evil.example', '/%5cevil.example',
    '/%2fevil.example', '/%0a/evil.example', '/login', '/auth/logout', '/api/sensors', 'bad', null, ['//evil']]) {
    assert.equal(safeNext(value), '/');
  }
});

test('usernames are bounded and normalized without accepting arbitrary objects', () => {
  assert.equal(normalizeUsername('  Andrew  '), 'andrew');
  assert.equal(normalizeUsername('kats@example.com'), 'kats@example.com');
  for (const value of [{}, null, 'x', 'bad name', 'a'.repeat(81)]) assert.equal(normalizeUsername(value), '');
});
