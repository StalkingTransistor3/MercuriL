(() => {
  const form = document.getElementById('signupForm');
  const button = document.getElementById('submit');
  const error = document.getElementById('error');
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); error.textContent = '';
    if (form.elements.password.value !== form.elements.confirm.value) {
      error.textContent = 'The passwords do not match.'; form.elements.confirm.focus(); return;
    }
    button.disabled = true; button.textContent = 'Submitting…';
    try {
      const response = await fetch('/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.elements.email.value, password: form.elements.password.value }) });
      const result = await response.json();
      if (!response.ok) { error.textContent = result.error || 'Could not submit your request. Please try again.'; return; }
      form.reset(); form.hidden = true;
      const success = document.getElementById('success'); success.hidden = false; success.focus();
    } catch { error.textContent = 'Could not connect. Please try again.'; }
    finally { button.disabled = false; button.textContent = 'Request access'; }
  });
})();
