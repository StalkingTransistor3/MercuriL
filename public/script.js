(() => {
  const form = document.getElementById('inquire-form');
  const btn = document.getElementById('submit-btn');
  const status = document.getElementById('form-status');

  if (!form) return;

  const setStatus = (msg, cls) => {
    status.textContent = msg;
    status.classList.remove('ok', 'err');
    if (cls) status.classList.add(cls);
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setStatus('Sending…');
    btn.disabled = true;

    const data = Object.fromEntries(new FormData(form).entries());

    try {
      const resp = await fetch('/api/inquire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = await resp.json().catch(() => ({}));

      if (resp.ok && json.ok) {
        form.reset();
        setStatus("Got it — we'll be in touch shortly.", 'ok');
      } else if (resp.status === 400 && Array.isArray(json.errors)) {
        setStatus(
          `Please check: ${json.errors.join(', ')}.`,
          'err'
        );
      } else if (resp.status === 429) {
        setStatus('Too many submissions from this network. Try again later.', 'err');
      } else {
        setStatus("Something went wrong on our end. Please try again in a moment.", 'err');
      }
    } catch (err) {
      setStatus('Network error. Please try again.', 'err');
    } finally {
      btn.disabled = false;
    }
  });
})();
