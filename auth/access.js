(() => {
  let filter = 'pending', offset = 0, busy = false;
  const list = document.getElementById('accounts');
  const message = document.getElementById('message');
  const status = (text, error = false) => { message.textContent = text; message.classList.toggle('error', error); };
  const date = (value) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  async function request(url, options) {
    const response = await fetch(url, options);
    if (response.status === 401 || response.status === 403) {
      location.replace('/admin/login?next=%2Fadmin%2Faccess'); throw new Error('Admin sign-in required.');
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not complete the request.');
    return result;
  }
  function render(user) {
    const card = document.createElement('article'); card.className = 'account';
    const info = document.createElement('div'); info.className = 'account-info';
    const name = document.createElement('h2'); name.textContent = user.email || user.username;
    const requested = document.createElement('p'); requested.textContent = `Requested ${date(user.created_at)}`;
    const reviewed = document.createElement('p');
    reviewed.textContent = user.reviewed_at ? `Last reviewed ${date(user.reviewed_at)} by ${user.reviewed_by}` : user.access_status === 'pending' ? 'Awaiting review' : 'Account provisioned by an operator';
    info.append(name, requested, reviewed);
    const actions = document.createElement('div'); actions.className = 'account-actions';
    const choices = user.disabled || user.access_status !== 'approved' ? [['approve', 'Approve']] : [['disable', 'Disable access']];
    if (user.access_status === 'pending' && !user.disabled) choices.push(['reject', 'Reject']);
    for (const [action, label] of choices) {
      const button = document.createElement('button'); button.type = 'button'; button.className = action; button.textContent = label;
      button.setAttribute('aria-label', `${label} ${user.email || user.username}`);
      button.addEventListener('click', () => decide(user, action)); actions.append(button);
    }
    card.append(info, actions); return card;
  }
  async function refresh() {
    const result = await request(`/auth/admin/users?status=${filter}&offset=${offset}`);
    for (const [name, value] of Object.entries(result.counts)) document.getElementById(`count-${name}`).textContent = value;
    list.replaceChildren(...result.users.map(render));
    if (!result.users.length) {
      const empty = document.createElement('p'); empty.className = 'empty';
      empty.textContent = filter === 'pending' ? 'No accounts are waiting for approval.' : `No ${filter} accounts to show.`;
      list.append(empty);
    }
    document.getElementById('previous').hidden = offset === 0;
    document.getElementById('more').hidden = !result.has_more;
  }
  async function decide(user, action) {
    if (busy) return;
    if (action === 'disable' && !confirm(`Disable access for ${user.email || user.username}? This signs them out of every session.`)) return;
    busy = true; document.querySelectorAll('button').forEach((b) => b.disabled = true); status('Saving decision…');
    try {
      await request('/auth/admin/users/decision', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user.username, action, expected_status: user.access_status, expected_disabled: user.disabled }) });
      await refresh(); status(`${user.email || user.username}: ${action === 'approve' ? 'approved. They can now sign in.' : action === 'reject' ? 'request rejected.' : 'access disabled.'}`);
    } catch (error) { status(error.message, true); await refresh().catch(() => {}); }
    finally { busy = false; document.querySelectorAll('button').forEach((b) => b.disabled = false); }
  }
  async function load() {
    if (busy) return; busy = true;
    try { await refresh(); } catch (error) { status(error.message, true); }
    finally { busy = false; }
  }
  document.querySelectorAll('[data-status]').forEach((button) => button.addEventListener('click', () => {
    if (busy) return; filter = button.dataset.status; offset = 0; status('');
    document.querySelectorAll('[data-status]').forEach((b) => b.setAttribute('aria-pressed', String(b === button))); load();
  }));
  document.getElementById('refresh').addEventListener('click', () => { status(''); load(); });
  document.getElementById('previous').addEventListener('click', () => { if (!busy) { offset = Math.max(0, offset - 50); load(); } });
  document.getElementById('more').addEventListener('click', () => { if (!busy) { offset += 50; load(); } });
  setInterval(() => { if (!document.hidden) load(); }, 30_000);
  load();
})();
