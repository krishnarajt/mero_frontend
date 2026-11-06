import { api, setSession } from '../api';
import { navigate } from '../router';

export function mountLogin(root: HTMLElement, next: string): () => void {
  root.innerHTML = `
    <div class="page center">
      <form class="card auth">
        <h1>mero</h1>
        <p class="muted">Infinite whiteboards. Log in, or pick a username and password to make an account.</p>
        <input name="username" placeholder="Username" autocomplete="username" autocapitalize="none" required />
        <input name="password" type="password" placeholder="Password" autocomplete="current-password" required />
        <div class="row">
          <button type="submit" class="primary">Log in</button>
          <button type="button" data-act="register">Create account</button>
        </div>
        <p class="error" hidden></p>
      </form>
    </div>`;
  const form = root.querySelector('form')!;
  const err = root.querySelector('.error') as HTMLElement;
  // Each button has its own handler rather than reading SubmitEvent.submitter,
  // which some tablet browsers do not implement.
  async function submit(mode: 'login' | 'register') {
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    err.hidden = true;
    form.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      const res = await api('POST', `/api/auth/${mode}`, {
        username: String(fd.get('username') || ''),
        password: String(fd.get('password') || ''),
      });
      setSession(res.token, res.user);
      navigate(next || '/', true);
    } catch (ex) {
      const msg = (ex as Error).message || 'Something went wrong';
      err.textContent = ex instanceof TypeError ? `Can't reach the server (${msg})` : msg;
      err.hidden = false;
    } finally {
      form.querySelectorAll('button').forEach((b) => (b.disabled = false));
    }
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit('login');
  });
  form.querySelector('[data-act="register"]')!.addEventListener('click', () => submit('register'));
  (form.querySelector('input') as HTMLInputElement).focus();
  return () => {};
}
