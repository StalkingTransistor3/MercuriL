// Exercise the real account CLI in its own schema; never use public accounts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
require('../lib/env').loadEnv();
const { Pool } = require('pg');
const { verifyPassword } = require('../lib/auth');
if (!process.argv.includes('--isolated-neon')) throw new Error('Pass --isolated-neon for isolated account tests');
const schema = `bench_access_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
const url = new URL(process.env.DATABASE_URL);
if (url.hostname.endsWith('.neon.tech')) url.hostname = url.hostname.replace('-pooler.', '.');
const db = new Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false }, max: 1 });
const testUrl = new URL(url);
testUrl.searchParams.set('options', `-c search_path=${schema}`);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mercuril-access-'));
async function cli(...args) {
  return execFile(process.execPath, [path.join(__dirname, '../bin/access.cjs'), ...args], {
    env: { ...process.env, DATABASE_URL: testUrl.toString() }, timeout: 60_000,
  });
}
(async () => {
  try {
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path=${schema}`);
    const firstFile = path.join(directory, 'first.json');
    const created = await cli('create', 'fixture-team', '--out', firstFile);
    const first = JSON.parse(fs.readFileSync(firstFile, 'utf8'));
    assert.equal(fs.statSync(firstFile).mode & 0o777, 0o600);
    assert.equal(created.stdout.includes(first.password), false);
    const stored = (await db.query('SELECT * FROM app_users')).rows[0];
    assert.equal(await verifyPassword(first.password, stored.password_hash), true);
    await assert.rejects(cli('create', 'fixture-team', '--out', path.join(directory, 'duplicate.json')));
    assert.equal(fs.existsSync(path.join(directory, 'duplicate.json')), false);
    await db.query("INSERT INTO app_sessions(token_hash, username, expires_at) VALUES ('fixture', 'fixture-team', now()+interval '1 day')");
    await cli('disable', 'fixture-team');
    assert.equal((await db.query('SELECT disabled FROM app_users')).rows[0].disabled, true);
    assert.equal((await db.query('SELECT count(*)::int n FROM app_sessions')).rows[0].n, 0);
    const secondFile = path.join(directory, 'second.json');
    await cli('reset', 'fixture-team', '--out', secondFile);
    const second = JSON.parse(fs.readFileSync(secondFile, 'utf8'));
    const reset = (await db.query('SELECT * FROM app_users')).rows[0];
    assert.equal(reset.disabled, false);
    assert.equal(await verifyPassword(first.password, reset.password_hash), false);
    assert.equal(await verifyPassword(second.password, reset.password_hash), true);
    const listed = JSON.parse((await cli('list')).stdout);
    assert.equal(listed.length, 1); assert.equal(listed[0].username, 'fixture-team');
    assert.equal('password_hash' in listed[0], false);
    console.log('PASS real account CLI: create, duplicate rejection, private files, disable, session revocation, reset and list');
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.end();
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(() => { console.error('Account CLI test failed; credentials and database errors suppressed'); process.exitCode = 1; });
