import type { Exec } from './exec';

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** application/x-www-form-urlencoded body */
  form?: Record<string, string | undefined>;
  json?: unknown;
  /** Bypass proxies (e.g. for the instance metadata endpoint). */
  noProxy?: boolean;
  timeoutSeconds?: number;
}

const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

/**
 * Minimal HTTP client based on curl, which is available on all common agents and honours the
 * proxy settings (HTTPS_PROXY/NO_PROXY) and CA bundle of the machine. The request, including
 * tokens, is passed as a curl config on stdin so secrets never show up in the process list.
 */
export async function httpRequest<T = unknown>(exec: Exec, req: HttpRequest): Promise<T> {
  const lines = [`url = ${quote(req.url)}`, `request = ${quote(req.method ?? (req.form || req.json ? 'POST' : 'GET'))}`];
  for (const [k, v] of Object.entries(req.headers ?? {})) lines.push(`header = ${quote(`${k}: ${v}`)}`);
  if (req.form) {
    const body = Object.entries(req.form)
      .filter((e): e is [string, string] => e[1] !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    lines.push(`header = "Content-Type: application/x-www-form-urlencoded"`, `data = ${quote(body)}`);
  } else if (req.json !== undefined) {
    lines.push(`header = "Content-Type: application/json"`, `data = ${quote(JSON.stringify(req.json))}`);
  }
  const timeout = req.timeoutSeconds ?? 30;
  const args = ['-sS', '--fail-with-body', '--max-time', String(timeout), '--config', '-'];
  if (timeout > 5) args.unshift('--retry', '2');
  if (req.noProxy) args.unshift('--noproxy', '*');
  const host = new URL(req.url).host;
  const r = await exec('curl', args, { input: lines.join('\n') + '\n', silent: true, ignoreReturnCode: true });
  if (r.exitCode !== 0) {
    const detail = r.stdout.trim().substring(0, 500) || r.stderr.trim();
    throw new Error(`HTTP request to ${host} failed (curl exit code ${r.exitCode}): ${detail}`);
  }
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new Error(`HTTP request to ${host} returned an invalid response`);
  }
}
