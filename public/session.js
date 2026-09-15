(() => {
  const nativeFetch = window.fetch.bind(window);
  let leaving = false;
  const adminPage = location.pathname.startsWith('/admin') || location.pathname.startsWith('/net');
  function signIn() {
    if (leaving) return;
    leaving = true;
    location.replace(`${adminPage ? '/admin/login' : '/login'}?expired=1&next=${encodeURIComponent(location.pathname + location.search + location.hash)}`);
  }
  // Existing pages keep their own error handling, but an expired login must not
  // leave a stale map or a silent telemetry console on screen indefinitely.
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    if (response.status === 401 && new URL(response.url, location.href).origin === location.origin) {
      const payload = await response.clone().json().catch(() => ({}));
      if (payload.code === 'LOGIN_REQUIRED') signIn();
    }
    return response;
  };
  const control = document.createElement('div');
  control.className = 'session-control';
  const label = document.createElement('span');
  const button = document.createElement('button');
  button.type = 'button'; button.textContent = 'Sign out';
  control.append(label, button);
  const host = document.querySelector('.about') || document.querySelector('.side header') || document.querySelector('.head');
  if (host?.classList.contains('about')) host.querySelector('.tagline').after(control);
  else if (host) host.append(control);
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const response = await nativeFetch('/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error('Sign-out failed');
      try { for (const key of ['mercuril_admin_key', 'mercuril-net-key']) localStorage.removeItem(key); }
      catch { /* Storage restrictions must not prevent a completed sign-out. */ }
      location.replace(adminPage ? '/admin/login' : '/login');
    } catch { button.disabled = false; button.textContent = 'Retry sign out'; }
  });
  async function refresh() {
    try {
      const response = await window.fetch('/auth/session');
      if (response.ok) {
        const user = await response.json(); label.textContent = user.username;
        if (user.is_admin && !control.querySelector('a')) {
          const link = document.createElement('a'); link.href = '/admin/access'; link.textContent = 'Admin console'; control.insertBefore(link, button);
        }
      }
    } catch { /* Data views surface their own connection errors. */ }
  }
  window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  refresh();
})();
