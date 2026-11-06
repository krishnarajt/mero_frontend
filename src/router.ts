type Render = (path: string) => void;

let render: Render = () => {};

export function setRenderer(fn: Render) {
  render = fn;
  window.addEventListener('popstate', () => render(location.pathname));
}

export function navigate(path: string, replace = false) {
  if (replace) history.replaceState(null, '', path);
  else if (path !== location.pathname + location.search) history.pushState(null, '', path);
  // Routes match on the pathname only; the query string stays in location.
  render(location.pathname);
}
