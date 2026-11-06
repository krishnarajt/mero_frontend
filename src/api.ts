const envBase = import.meta.env.VITE_API_BASE_URL as string | undefined;

/** Empty in local dev: Vite proxies /api and /ws to the backend. */
export const API_BASE = (envBase ?? (import.meta.env.PROD ? 'https://mero_backend.krishnarajthadesar.in' : '')).replace(/\/$/, '');

export function wsUrl(path: string): string {
  const base = API_BASE || location.origin;
  return base.replace(/^http/, 'ws') + path;
}

const TOKEN_KEY = 'mero.token';
const USER_KEY = 'mero.user';

export interface User {
  id: number;
  username: string;
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function getUser(): User | null {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  } catch {
    return null;
  }
}

export function setSession(token: string, user: User) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(API_BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && token) {
    clearSession();
    onUnauthorized();
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = typeof j.detail === 'string' ? j.detail : msg;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, msg);
  }
  return res.json();
}
