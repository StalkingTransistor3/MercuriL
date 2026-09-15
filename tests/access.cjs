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
    const adminFile = path.join(directory, 'admin.json');
    await cli('create-admin', 'admin', '--out', adminFile);
    const admin = JSON.parse(fs.readFileSync(adminFile, 'utf8'));
    const adminRow = (await db.query("SELECT is_admin,access_status FROM app_users WHERE username='admin'")).rows[0];
    assert.equal(adminRow.is_admin, true); assert.equal(adminRow.access_status, 'approved');
    const appDb = new Pool({ connectionString: testUrl.toString(), ssl: { rejectUnauthorized: false }, max: 2 });
    try { await require('./approval-checks.cjs')({ db: appDb, adminPassword: admin.password, cli, directory }); }
    finally { await appDb.end(); }
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.end();
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(`Account checks failed (${error.code || error.name}); credential values suppressed`);
  const frame = String(error.stack).split('\n').find((line) => /at .*\/tests\//.test(line));
  if (frame) console.error(frame.trim());
  process.exitCode = 1;
});
