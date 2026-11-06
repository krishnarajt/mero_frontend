import './style.css';
import { api, getToken, setUnauthorizedHandler } from './api';
import { mountBoard } from './board/board';
import { mountHome } from './pages/home';
import { mountLogin } from './pages/login';
import { navigate, setRenderer } from './router';
import { initTheme } from './theme';

initTheme();
const root = document.getElementById('app')!;
let cleanup: () => void = () => {};

function render(path: string) {
  cleanup();
  cleanup = () => {};
  root.innerHTML = '';

  if (path === '/login') {
    const next = new URLSearchParams(location.search).get('next') || '/';
    cleanup = mountLogin(root, next);
    return;
  }
  if (!getToken()) {
    navigate(`/login?next=${encodeURIComponent(path)}`, true);
    return;
  }
  const join = path.match(/^\/join\/([\w-]+)$/);
  if (join) {
    root.innerHTML = '<div class="page center"><p class="muted">Joining…</p></div>';
    api('POST', '/api/workspaces/join', { code: join[1] })
      .then(() => navigate('/', true))
      .catch((e) => (root.innerHTML = `<div class="page center"><p class="error">${e.message}</p></div>`));
    return;
  }
  const board = path.match(/^\/b\/([\w-]+)$/);
  if (board) {
    cleanup = mountBoard(root, board[1]);
    return;
  }
  cleanup = mountHome(root);
}

setUnauthorizedHandler(() => navigate(`/login?next=${encodeURIComponent(location.pathname)}`, true));
setRenderer(render);
render(location.pathname);
