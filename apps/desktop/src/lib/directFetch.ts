import { rootCertificates } from 'node:tls';
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * Outbound HTTP for the main process that the environment cannot redirect or re-root.
 *
 * Node installs a global proxy dispatcher (EnvHttpProxyAgent) during pre-execution when NODE_USE_ENV_PROXY is set,
 * and NODE_USE_SYSTEM_CA / NODE_EXTRA_CA_CERTS extend the default CA store, all before any app code runs; deleting
 * the variables later has no effect. So provider requests never use the global dispatcher: they go through the
 * npm `undici` fetch with an explicit Agent that
 * - connects directly (an Agent never consults HTTP(S)_PROXY / NO_PROXY), and
 * - trusts exactly Node's bundled Mozilla root store (`tls.rootCertificates`, which those variables do not change).
 * This restricts trust to the bundled root store; it is not certificate or CA pinning: any certificate that chains
 * to one of those roots is accepted.
 */
export function createBundledRootsDispatcher(): Agent {
  return new Agent({
    connect: { ca: [...rootCertificates], rejectUnauthorized: true },
    keepAliveTimeout: 10_000,
    connections: 8,
    // HTTP/1.1 only, as before undici 8 (which negotiates h2 by default): `connections` caps sockets per origin.
    allowH2: false,
  });
}

type FetchInput = string | URL | Request;

/** A `fetch` bound to `dispatcher` (any caller-supplied dispatcher is ignored). */
export function createDirectFetch(dispatcher: Agent = createBundledRootsDispatcher()): typeof fetch {
  const direct = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    let url: string;
    let merged: RequestInit = { ...init };
    if (typeof input === 'string') url = input;
    else if (input instanceof URL) url = input.href;
    else {
      // A WHATWG Request from Node's built-in fetch is a different class from undici's: pass its parts instead.
      url = input.url;
      const body = input.method === 'GET' || input.method === 'HEAD' ? undefined : await input.arrayBuffer();
      merged = { method: input.method, headers: input.headers, redirect: input.redirect, signal: input.signal, ...(body ? { body } : {}), ...init };
    }
    const res = await undiciFetch(url, { ...(merged as object), dispatcher } as Parameters<typeof undiciFetch>[1]);
    return res as unknown as Response;
  };
  return direct as typeof fetch;
}
