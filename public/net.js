/* The net viewer: a live window onto raw_hooks. Admin-gated because the net
 * stores whatever anyone posted. RockBLOCK form bodies get their `data` hex
 * decoded inline — the one transform a human always does by hand otherwise.
 */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let KEY = localStorage.getItem('mercuril-net-key') || '';
let lastTopId = null;
let timer = null;

const fmt = (t) => new Date(t).toLocaleString('en-AU',
  { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

function hexToText(hex) {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2) return null;
  try {
    const t = decodeURIComponent(hex.replace(/(..)/g, '%$1'));
    return /[\u0000-\u0008\u000e-\u001f]/.test(t) ? null : t;
  } catch { return null; }
}

function renderBody(r) {
  const text = r.body_text;
  // RockBLOCK delivery? Parse the form, decode the payload hex.
  if (text && /(^|&)imei=/.test(text) && text.includes('data=')) {
    const p = Object.fromEntries(new URLSearchParams(text));
    const dec = p.data ? hexToText(p.data) : null;
    return `momsn ${esc(p.momsn)} · transmit ${esc(p.transmit_time)} UTC · pos ${esc(p.iridium_latitude)},${esc(p.iridium_longitude)} (±${esc(p.iridium_cep)} km) · imei ${esc(p.imei)}\n` +
      (dec ? `<span class="dec">data → ${esc(dec)}</span>` : `data (hex): ${esc((p.data || '').slice(0, 120))}`);
  }
  if (text) {
    const dec = hexToText(text.trim());
    return esc(text.slice(0, 600)) + (dec && dec !== text ? `\n<span class="dec">hex → ${esc(dec)}</span>` : '');
  }
  if (r.body_hex) return `binary, ${r.bytes} bytes: ${esc(r.body_hex.slice(0, 96))}…`;
  return '(empty)';
}

async function poll() {
  try {
    const res = await fetch('/api/raw?hours=168&limit=50', { headers: { 'x-admin-key': KEY } });
    if (res.status === 401) {
      $('list').innerHTML = '<div class="empty">Wrong key.</div>';
      localStorage.removeItem('mercuril-net-key');
      return;
    }
    const rows = await res.json();
    $('keyrow').style.display = 'none';
    $('live').textContent = `${rows.length} caught · checked ${new Date().toLocaleTimeString('en-AU', { hour12: false })}`;
    if (!rows.length) {
      $('list').innerHTML = '<div class="empty">Net is empty. Whatever arrives next is kept.</div>';
      return;
    }
    const topId = rows[0].id;
    $('list').innerHTML = rows.map((r) => `
      <div class="catch${lastTopId !== null && Number(r.id) > Number(lastTopId) ? ' fresh' : ''}">
        <div class="c-head">
          <span class="id">#${esc(r.id)}</span>
          <span>${fmt(r.received_at)}</span>
          <span class="tag">${esc(r.content_type || 'unknown')}</span>
          <span>${r.bytes} B</span>
          ${r.authed ? '<span class="authed">authed</span>' : ''}
        </div>
        <div class="c-body">${renderBody(r)}</div>
      </div>`).join('');
    lastTopId = topId;
  } catch (err) {
    $('live').textContent = `fetch failed: ${err.message}`;
  }
}

function start() {
  if (!KEY) return;
  localStorage.setItem('mercuril-net-key', KEY);
  poll();
  if (!timer) timer = setInterval(() => { if (!document.hidden) poll(); }, 10_000);
}

$('go').addEventListener('click', () => { KEY = $('key').value.trim(); start(); });
$('key').addEventListener('keydown', (e) => { if (e.key === 'Enter') { KEY = $('key').value.trim(); start(); } });
if (KEY) { $('key').value = KEY; start(); }
