// SPDX-License-Identifier: CPAL-1.0
// Hyperliquid WebSocket 客户端（搬自 早期 Demo 原型 src/market/hl-ws.ts）：订阅记忆 + 重连后自动重订、30 s ping、
// 默认 45 s 无消息视为断、指数退避重连 1 s→30 s。只做连接管理，不懂业务；业务消息经 onMessage 交给上层。
import { sharedHlWsSendBudget } from './ws-budget'
import type { HlWsSendBudget } from './ws-budget'

export interface WsMessage { channel: string; data?: any }
export type WsDownReason = 'close' | 'error' | 'stale';

export interface HlWsOptions {
  url: string;
  WebSocketImpl: typeof WebSocket;
  clock: () => number;
  onMessage: (msg: WsMessage, ts: number) => void;
  /** 本次连接收到第一条消息（真正可用）。 */
  onLive?: () => void;
  /** 连接断了（含从未成功的尝试）；failures = 连续失败次数（收到过消息后清零）。 */
  onDown?: (reason: WsDownReason, failures: number) => void;
  pingMs?: number;        // 默认 30 000
  staleMs?: number;       // 默认 max(45 000, pingMs + 15 000)
  sendBudget?: HlWsSendBudget; // 未提供时使用模块共享 2000 / 60 s 预算
  backoffBaseMs?: number; // 默认 1 000
  backoffMaxMs?: number;  // 默认 30 000
}

const OPEN = 1;

interface QueuedSend {
  socket: WebSocket
  text: string
  kind: 'subscribe' | 'unsubscribe' | 'ping'
  subscriptionKey?: string
}

export class HlWsClient {
  private sock: WebSocket | null = null;
  private subs = new Map<string, object>();
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: QueuedSend[] = [];
  private readonly sentSubs = new Set<string>();
  private stopped = true;
  private _live = false;
  private _failures = 0;
  private _lastMsgTs = 0;
  private _rttMs = 0;
  private pingSentAt = 0;
  private subSentAt = 0;
  private nextDelay = 0;

  constructor(private readonly o: HlWsOptions) {}

  get live() { return this._live; }
  get subscriptionCount() { return this.subs.size; }
  get failures() { return this._failures; }
  get lastMsgTs() { return this._lastMsgTs; }
  /** 最近一次往返时延：pong 或订阅回执；还没有则 0。 */
  get rttMs() { return this._rttMs; }
  /** 当前计划/已用的重连等待（ms），便于测试与诊断。 */
  get lastBackoffMs() { return this.nextDelay; }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this._live = false;
    this.clearTimers();
    this.clearPending();
    const s = this.sock;
    this.sock = null;
    if (s) try { s.close(); } catch { /* 已关 */ }
  }

  subscribe(sub: object): void {
    this.subs.set(JSON.stringify(sub), sub);
    this.sendSub('subscribe', sub);
  }

  unsubscribe(sub: object): void {
    const key = JSON.stringify(sub);
    if (!this.subs.delete(key)) return;
    const socket = this.sock;
    const wasSent = this.sentSubs.has(key);
    this.cancelPendingSubscribe(socket, key);
    if (wasSent) this.sendSub('unsubscribe', sub);
  }

  private sendSub(method: 'subscribe' | 'unsubscribe', sub: object) {
    const socket = this.sock;
    if (socket?.readyState === OPEN) this.send(socket, { method, subscription: sub }, method, JSON.stringify(sub));
  }

  private send(socket: WebSocket, obj: object, kind: QueuedSend['kind'], subscriptionKey?: string) {
    if (this.stopped || this.sock !== socket || socket.readyState !== OPEN) return;
    const item: QueuedSend = { socket, text: JSON.stringify(obj), kind, ...(subscriptionKey === undefined ? {} : { subscriptionKey }) };
    const budget = this.o.sendBudget ?? sharedHlWsSendBudget;
    if (this.pending.length > 0 || !budget.tryAcquire()) {
      this.pending.push(item);
      this.scheduleFlush();
      return;
    }
    this.sendNow(item);
  }

  private sendNow(item: QueuedSend): boolean {
    const { socket } = item;
    if (this.stopped || this.sock !== socket || socket.readyState !== OPEN) return false;
    if (item.kind === 'subscribe' && item.subscriptionKey !== undefined && !this.subs.has(item.subscriptionKey)) return true;
    try {
      socket.send(item.text);
    } catch {
      this.down('error', socket);
      return false;
    }
    if (item.kind === 'subscribe' && item.subscriptionKey !== undefined) {
      this.sentSubs.add(item.subscriptionKey);
      if (this.subSentAt === 0) this.subSentAt = this.o.clock();
    } else if (item.kind === 'unsubscribe' && item.subscriptionKey !== undefined) {
      this.sentSubs.delete(item.subscriptionKey);
    } else if (item.kind === 'ping') {
      this.pingSentAt = this.o.clock();
    }
    return true;
  }

  private scheduleFlush() {
    if (this.flushTimer || this.pending.length === 0 || this.stopped) return;
    const waitMs = (this.o.sendBudget ?? sharedHlWsSendBudget).remainingWaitMs();
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushPending();
    }, Math.max(1, waitMs));
  }

  private flushPending() {
    const budget = this.o.sendBudget ?? sharedHlWsSendBudget;
    while (this.pending.length > 0) {
      const item = this.pending[0]!;
      if (this.stopped || this.sock !== item.socket || item.socket.readyState !== OPEN) {
        this.pending.shift();
        continue;
      }
      if (item.kind === 'subscribe' && item.subscriptionKey !== undefined && !this.subs.has(item.subscriptionKey)) {
        this.pending.shift();
        continue;
      }
      if (!budget.tryAcquire()) {
        this.scheduleFlush();
        return;
      }
      this.pending.shift();
      if (!this.sendNow(item)) return;
    }
  }

  private cancelPendingSubscribe(socket: WebSocket | null, key: string) {
    if (socket === null) return;
    this.pending = this.pending.filter((item) => !(item.socket === socket && item.kind === 'subscribe' && item.subscriptionKey === key));
    if (this.pending.length === 0 && this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private clearPending() {
    this.pending = [];
    this.sentSubs.clear();
  }

  private connect() {
    if (this.stopped) return;
    this.clearTimers();
    let sock: WebSocket;
    try {
      sock = new this.o.WebSocketImpl(this.o.url);
    } catch {
      this.down('error', null);
      return;
    }
    this.sock = sock;
    this.subSentAt = 0;
    this.sentSubs.clear();
    this.armStale();
    sock.addEventListener('open', () => {
      if (this.sock !== sock) return;
      this.sentSubs.clear();
      for (const sub of this.subs.values()) this.sendSub('subscribe', sub);
      this.armPing();
    });
    sock.addEventListener('message', (ev: MessageEvent) => {
      if (this.sock !== sock) return;
      this.onRaw(ev.data);
    });
    sock.addEventListener('error', () => this.down('error', sock));
    sock.addEventListener('close', () => this.down('close', sock));
  }

  private onRaw(data: unknown) {
    let text: string;
    if (typeof data === 'string') text = data;
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
    else return;
    let msg: WsMessage;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg.channel !== 'string') return;
    const now = this.o.clock();
    this._lastMsgTs = now;
    this.armStale();
    if (!this._live) {
      this._live = true;
      this._failures = 0;
      this.nextDelay = 0;
      this.o.onLive?.();
    }
    if (msg.channel === 'pong') {
      if (this.pingSentAt) this._rttMs = Math.max(0, now - this.pingSentAt);
      this.pingSentAt = 0;
      return;
    }
    if (msg.channel === 'subscriptionResponse' && this.subSentAt > 0) {
      this._rttMs = Math.max(0, now - this.subSentAt);
      this.subSentAt = -1; // 只取每条连接的第一次回执
    }
    this.o.onMessage(msg, now);
  }

  /** sock = null 表示 stale 看门狗触发（对当前 socket）。 */
  private down(reason: WsDownReason, sock: WebSocket | null) {
    if (this.stopped) return;
    if (sock && this.sock !== sock) return; // 旧连接的迟到事件
    const dead = this.sock;
    this.sock = null;
    this._live = false;
    this.clearTimers();
    this.clearPending();
    if (dead) try { dead.close(); } catch { /* 已关 */ }
    this._failures++;
    const base = this.o.backoffBaseMs ?? 1000;
    const max = this.o.backoffMaxMs ?? 30_000;
    this.nextDelay = Math.min(max, base * 2 ** (this._failures - 1));
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, this.nextDelay);
    this.o.onDown?.(reason, this._failures);
  }

  private armStale() {
    if (this.staleTimer) clearTimeout(this.staleTimer);
    const staleMs = this.o.staleMs ?? Math.max(45_000, (this.o.pingMs ?? 30_000) + 15_000);
    this.staleTimer = setTimeout(() => { this.staleTimer = null; this.down('stale', this.sock); }, staleMs);
  }

  private armPing() {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = setTimeout(() => {
      this.pingTimer = null;
      if (this.sock?.readyState === OPEN) {
        this.send(this.sock, { method: 'ping' }, 'ping');
      }
      if (!this.stopped && this.sock) this.armPing();
    }, this.o.pingMs ?? 30_000);
  }

  private clearTimers() {
    for (const k of ['pingTimer', 'staleTimer', 'reconnectTimer', 'flushTimer'] as const) {
      if (this[k]) { clearTimeout(this[k]!); this[k] = null; }
    }
  }
}
