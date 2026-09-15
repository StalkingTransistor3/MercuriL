(() => {
  const form = document.getElementById('loginForm');
  const password = document.getElementById('password');
  const error = document.getElementById('error');
  const submit = document.getElementById('submit');
  const params = new URLSearchParams(location.search);
  const admin = form.dataset.admin === 'true';
  if (params.get('expired') === '1') error.textContent = 'Your session has ended. Please sign in again.';
  document.getElementById('reveal').addEventListener('click', (event) => {
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    event.currentTarget.textContent = show ? 'Hide' : 'Show';
    event.currentTarget.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    event.currentTarget.setAttribute('aria-pressed', String(show));
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    error.textContent = '';
    try {
      const response = await fetch(admin ? '/auth/admin/login' : '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: admin ? undefined : form.elements.username.value, password: password.value, next: params.get('next') || (admin ? '/admin/access' : '/') }) });
      const result = await response.json();
      if (!response.ok) { error.textContent = result.error || 'Could not sign in. Please try again.'; password.focus(); return; }
      password.value = '';
      location.replace(result.next);
    } catch { error.textContent = 'Could not connect. Please try again.'; }
    finally { submit.disabled = false; submit.textContent = 'Sign in'; }
  });
})();
