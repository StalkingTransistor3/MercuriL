#!/usr/bin/env node
// Account administration runs on the server. Passwords never appear in argv,
// stdout or Git: create/reset generates a password into a new private file.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
require('../lib/env').loadEnv();
const { getPool } = require('../lib/db');
const { AUTH_SCHEMA, hashPassword, normalizeUsername } = require('../lib/auth');

async function main() {
  const [action, input, flag, output] = process.argv.slice(2);
  const username = normalizeUsername(input);
  const creates = ['create', 'create-admin'].includes(action);
  if (!['create', 'create-admin', 'reset', 'disable', 'list'].includes(action) || (action !== 'list' && !username) ||
      ((creates || action === 'reset') && (flag !== '--out' || !output))) {
    throw new Error('Usage: node bin/access.cjs create|create-admin|reset USERNAME --out /private/new-file.json\n       node bin/access.cjs disable USERNAME\n       node bin/access.cjs list');
  }
  if (action === 'create-admin' && username !== 'admin') throw new Error('The password-only admin console uses the reserved username admin');
  if (action === 'create' && username === 'admin') throw new Error('Use create-admin to provision the admin console');
  let target, password, passwordHash;
  if (creates || action === 'reset') {
    if (!path.isAbsolute(output)) throw new Error('--out must be an absolute path outside this repository');
    const parent = fs.realpathSync(path.dirname(output));
    target = path.join(parent, path.basename(output));
    const repo = fs.realpathSync(path.join(__dirname, '..'));
    if (target === repo || target.startsWith(repo + path.sep)) throw new Error('Credential files must stay outside the public repository');
    password = crypto.randomBytes(24).toString('base64url');
    passwordHash = await hashPassword(password);
    // Reserve the destination before changing credentials. Never replace a file.
    const fd = fs.openSync(target, 'wx', 0o600);
    fs.closeSync(fd);
  }
  const pool = getPool();
  let db;
  try {
    db = await pool.connect();
    await db.query(AUTH_SCHEMA);
    if (action === 'list') {
      const { rows } = await db.query('SELECT username, email, access_status, is_admin, disabled, created_at FROM app_users ORDER BY username');
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    await db.query('BEGIN');
    if (creates) {
      await db.query("INSERT INTO app_users(username, password_hash, access_status, is_admin) VALUES ($1,$2,'approved',$3)", [username, passwordHash, action === 'create-admin']);
    } else {
      const result = action === 'disable'
        ? await db.query('UPDATE app_users SET disabled=true WHERE username=$1', [username])
        : await db.query('UPDATE app_users SET password_hash=$2, disabled=false WHERE username=$1', [username, passwordHash]);
      if (result.rowCount !== 1) throw new Error('Account not found');
      await db.query('DELETE FROM app_sessions WHERE username=$1', [username]);
    }
    if (target) fs.writeFileSync(target, JSON.stringify({ url: `https://mercuril-production.up.railway.app/${username === 'admin' ? 'admin/login' : 'login'}`, username, password }, null, 2) + '\n', { mode: 0o600 });
    await db.query('COMMIT');
    console.log(`Account ${username}: ${action} completed.${target ? ` Credentials saved privately to ${target}` : ' Existing sessions revoked.'}`);
  } catch (err) {
    if (db) await db.query('ROLLBACK').catch(() => {});
    if (target) fs.unlinkSync(target);
    // Do not print connection strings, SQL parameters or a password hash.
    throw new Error(err.code === '23505' ? 'Account already exists; use reset to rotate credentials' : 'Account update failed; no success confirmed');
  } finally { if (db) db.release(); await pool.end(); }
}
main().catch((err) => { console.error(err.message); process.exitCode = 1; });
