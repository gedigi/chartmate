import type { Server } from 'node:net';

/**
 * "No listener" enforcement for the main process: `net.Server.prototype.listen` (and therefore http/https servers)
 * throws. The ONLY exception is the macOS auto-update install: electron-updater hands the downloaded zip to the
 * native Squirrel.Mac updater through a short-lived HTTP server on 127.0.0.1 (random port, random URL, basic auth).
 * While the updater arms the guard (right when electron-updater starts serving a finished download, see
 * updateArming.ts), exactly one listener may open, and only on a loopback address with an
 * ephemeral port (0). Every decision is reported through `audit`.
 */
export interface ListenGuard {
  /** Allows one loopback listener for the next `ms` (default: the guard's `armMs`); returns a disarm function. */
  armForUpdateInstall(ms?: number): () => void;
  uninstall(): void;
}

const LOOPBACK = new Set(['127.0.0.1', '::1']);

interface ParsedListen { port: unknown; host: unknown; path: unknown }

function parseArgs(args: unknown[]): ParsedListen {
  const [a, b] = args;
  if (a !== null && typeof a === 'object' && !Array.isArray(a)) {
    const o = a as Record<string, unknown>;
    return { port: o.port, host: o.host, path: o.path };
  }
  if (typeof a === 'string' && !/^\d+$/.test(a)) return { port: undefined, host: undefined, path: a };
  return { port: a, host: typeof b === 'string' ? b : undefined, path: undefined };
}

export function installListenGuard(
  proto: { listen: Server['listen'] },
  opts: { audit: (msg: string) => void; now?: () => number; armMs?: number },
): ListenGuard {
  const original = proto.listen;
  const now = opts.now ?? Date.now;
  const armMs = opts.armMs ?? 60_000;
  let armedUntil = 0;

  function guardedListen(this: Server, ...args: unknown[]): Server {
    const { port, host, path } = parseArgs(args);
    const armed = armedUntil > now();
    const ok = armed && path === undefined && (port === 0 || port === '0') && typeof host === 'string' && LOOPBACK.has(host);
    if (!ok) {
      opts.audit(`refused listener (host=${String(host ?? path ?? '*')}, armed=${armed})`);
      throw new Error('listening sockets are disabled in the desktop app');
    }
    armedUntil = 0; // single use
    this.once('listening', () => {
      const a = this.address();
      opts.audit(`allowed loopback listener for update install on ${typeof a === 'object' && a ? `${a.address}:${a.port}` : String(a)}`);
    });
    this.once('close', () => opts.audit('update-install loopback listener closed'));
    return (original as (...a: unknown[]) => Server).apply(this, args);
  }

  proto.listen = guardedListen as Server['listen'];
  return {
    armForUpdateInstall(ms?: number) {
      armedUntil = now() + (ms ?? armMs);
      opts.audit('listener guard armed for an update install');
      return () => {
        armedUntil = 0;
      };
    },
    uninstall() {
      proto.listen = original;
    },
  };
}
