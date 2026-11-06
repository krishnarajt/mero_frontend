import { getToken, wsUrl } from '../api';
import type { RawStroke } from './strokes';

export interface SyncHandlers {
  init(msg: { cid: number; strokes: RawStroke[]; live: RawStroke[]; peers: { cid: number; name: string }[] }): void;
  begin(s: RawStroke): void;
  append(id: string, p: number[]): void;
  end(id: string): void;
  del(ids: string[]): void;
  add(s: RawStroke[]): void;
  update(s: RawStroke[]): void;
  cursor(cid: number, x?: number, y?: number): void;
  join(cid: number, name: string): void;
  leave(cid: number): void;
  status(state: 'connecting' | 'open' | 'closed', rtt?: number): void;
  fatal(reason: string): void;
}

/**
 * The board's websocket. Stroke points are buffered and flushed once per
 * animation frame, so a 240 Hz pen costs one frame per display refresh
 * rather than one per sample. Everything else goes out immediately.
 */
export class Sync {
  private ws: WebSocket | null = null;
  private pending = new Map<string, number[]>();
  private flushReq = 0;
  private pingTimer = 0;
  private retry = 0;
  private retryTimer = 0;
  private stopped = false;
  /** True once the server's init has arrived; before that nothing is sent. */
  private ready = false;
  rtt = 0;

  constructor(
    private boardId: string,
    private h: SyncHandlers,
  ) {
    this.connect();
  }

  get open() {
    return this.ready && this.ws?.readyState === WebSocket.OPEN;
  }

  close() {
    this.stopped = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    cancelAnimationFrame(this.flushReq);
    this.ws?.close();
  }

  private connect() {
    this.h.status('connecting');
    const ws = new WebSocket(wsUrl(`/ws/boards/${this.boardId}`));
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'auth', token: getToken() }));
      this.retry = 0;
      this.ping();
      clearInterval(this.pingTimer);
      // Also keeps Cloudflare's 100 s idle timeout from closing the socket.
      this.pingTimer = window.setInterval(() => this.ping(), 5000);
    };
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (Array.isArray(data)) for (const m of data) this.dispatch(m);
      else this.dispatch(data);
    };
    ws.onclose = (e) => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.ready = false;
      this.ws = null;
      if (this.stopped) return;
      if (e.code === 4401) return this.h.fatal('auth');
      if (e.code === 4404) return this.h.fatal('gone');
      this.h.status('closed');
      const delay = Math.min(5000, 250 * 2 ** this.retry++);
      this.retryTimer = window.setTimeout(() => this.connect(), delay);
    };
  }

  private dispatch(m: any) {
    switch (m.t) {
      case 'a':
        return this.h.append(m.id, m.p);
      case 'm':
        return this.h.cursor(m.cid, m.x, m.y);
      case 'b':
        return this.h.begin(m);
      case 'e':
        return this.h.end(m.id);
      case 'd':
        return this.h.del(m.ids);
      case 'r':
        return this.h.add(m.s);
      case 'u':
        return this.h.update(m.s);
      case 'init':
        this.ready = true;
        this.h.status('open', this.rtt);
        return this.h.init(m);
      case 'join':
        return this.h.join(m.cid, m.name);
      case 'leave':
        return this.h.leave(m.cid);
      case 'pong':
        this.rtt = Math.round(performance.now() - m.ts);
        return this.h.status('open', this.rtt);
    }
  }

  private ping() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'ping', ts: performance.now() }));
  }

  private raw(obj: unknown): boolean {
    if (!this.open) return false;
    this.ws!.send(JSON.stringify(obj));
    return true;
  }

  /** Sends anything buffered first, so ordering is kept. */
  send(obj: unknown): boolean {
    this.flush();
    return this.raw(obj);
  }

  points(id: string, p: number[]) {
    const buf = this.pending.get(id);
    if (buf) for (let i = 0; i < p.length; i++) buf.push(p[i]);
    else this.pending.set(id, p.slice());
    if (!this.flushReq) this.flushReq = requestAnimationFrame(() => this.flush());
  }

  flush() {
    cancelAnimationFrame(this.flushReq);
    this.flushReq = 0;
    if (!this.pending.size) return;
    for (const [id, p] of this.pending) this.raw({ t: 'a', id, p });
    this.pending.clear();
  }
}
