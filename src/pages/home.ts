import { api, clearSession, getUser } from '../api';
import { navigate } from '../router';
import { isDark, toggleTheme } from '../theme';

interface Workspace {
  id: string;
  name: string;
  is_owner: boolean;
  invite_code: string;
  members: string[];
  boards: { id: string; name: string }[];
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function mountHome(root: HTMLElement): () => void {
  let alive = true;
  const user = getUser();
  root.innerHTML = `
    <div class="page home">
      <header>
        <h1>mero</h1>
        <div class="spacer"></div>
        <span class="muted">${esc(user?.username || '')}</span>
        <button data-act="theme">${isDark() ? 'Light mode' : 'Dark mode'}</button>
        <button data-act="logout">Log out</button>
      </header>
      <main><p class="muted">Loading…</p></main>
    </div>`;
  const main = root.querySelector('main')!;

  async function load() {
    let list: Workspace[];
    try {
      list = await api('GET', '/api/workspaces');
    } catch (e) {
      main.innerHTML = `<p class="error">${esc((e as Error).message)}</p>`;
      return;
    }
    if (!alive) return;
    if (!list.length) {
      await api('POST', '/api/workspaces', { name: 'Personal' });
      return load();
    }
    main.innerHTML =
      list
        .map(
          (w) => `
      <section class="ws" data-ws="${w.id}">
        <div class="ws-head">
          <h2>${esc(w.name)}</h2>
          <span class="muted small">${w.members.map(esc).join(', ')}</span>
          <div class="spacer"></div>
          <button class="small" data-act="invite" data-code="${w.invite_code}">Copy invite link</button>
          <button class="small" data-act="rename-ws">Rename</button>
          <button class="small danger" data-act="delete-ws">${w.is_owner ? 'Delete' : 'Leave'}</button>
        </div>
        <div class="boards">
          ${w.boards
            .map(
              (b) => `
            <div class="tile" data-board="${b.id}">
              <a href="/b/${b.id}" data-link>${esc(b.name)}</a>
              <div class="tile-acts">
                <button class="small" data-act="rename-board" title="Rename">✎</button>
                <button class="small danger" data-act="delete-board" title="Delete">✕</button>
              </div>
            </div>`,
            )
            .join('')}
          <button class="tile new" data-act="new-board">+ New board</button>
        </div>
      </section>`,
        )
        .join('') + `<button class="primary" data-act="new-ws">+ New workspace</button>`;
  }

  // On the page element, not root: root outlives this page.
  root.querySelector('.page')!.addEventListener('click', async (e) => {
    const el = e.target as HTMLElement;
    const link = el.closest('a[data-link]') as HTMLAnchorElement | null;
    if (link) {
      e.preventDefault();
      navigate(link.getAttribute('href')!);
      return;
    }
    const btn = el.closest('button') as HTMLButtonElement | null;
    if (!btn) return;
    const wsId = (btn.closest('[data-ws]') as HTMLElement | null)?.dataset.ws;
    const boardId = (btn.closest('[data-board]') as HTMLElement | null)?.dataset.board;
    const act = btn.dataset.act;
    try {
      if (act === 'theme') {
        toggleTheme();
        btn.textContent = isDark() ? 'Light mode' : 'Dark mode';
        return;
      } else if (act === 'logout') {
        clearSession();
        navigate('/login');
        return;
      } else if (act === 'new-ws') {
        const name = prompt('Workspace name')?.trim();
        if (name) await api('POST', '/api/workspaces', { name });
      } else if (act === 'new-board' && wsId) {
        const name = prompt('Board name', 'Untitled')?.trim();
        if (!name) return;
        const b = await api('POST', `/api/workspaces/${wsId}/boards`, { name });
        navigate(`/b/${b.id}`);
        return;
      } else if (act === 'rename-ws' && wsId) {
        const name = prompt('Workspace name')?.trim();
        if (name) await api('PATCH', `/api/workspaces/${wsId}`, { name });
      } else if (act === 'delete-ws' && wsId) {
        if (!confirm('Delete this workspace and every board in it? (If you are not the owner you just leave it.)')) return;
        await api('DELETE', `/api/workspaces/${wsId}`);
      } else if (act === 'rename-board' && boardId) {
        const name = prompt('Board name')?.trim();
        if (name) await api('PATCH', `/api/boards/${boardId}`, { name });
      } else if (act === 'delete-board' && boardId) {
        if (!confirm('Delete this board for everyone?')) return;
        await api('DELETE', `/api/boards/${boardId}`);
      } else if (act === 'invite') {
        const url = `${location.origin}/join/${btn.dataset.code}`;
        try {
          await navigator.clipboard.writeText(url);
          btn.textContent = 'Copied';
          setTimeout(() => (btn.textContent = 'Copy invite link'), 1500);
        } catch {
          prompt('Invite link', url);
        }
        return;
      } else return;
      await load();
    } catch (ex) {
      alert((ex as Error).message);
    }
  });

  load();
  return () => {
    alive = false;
  };
}
