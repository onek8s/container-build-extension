import { describe, expect, it } from 'vitest';
import { runE2E } from '../scripts/azure-devops-e2e.mjs';
import { DEV_EXTENSION_ID, DEV_TASK_ID, toDevVariant } from '../scripts/package-azure.mjs';

const env = {
  ADO_TOKEN: 'tok',
  ADO_ORGANIZATION: 'org',
  ADO_PROJECT: 'E2E Project',
  ADO_PIPELINE_ID: '7',
  EXPECTED_VERSION: '0.4.4201',
  E2E_ACR: 'myacr.azurecr.io',
  REF: 'refs/heads/feature',
};

type Route = (url: string, init: RequestInit) => { status?: number; body?: unknown } | undefined;

function fakeFetch(routes: Route[]) {
  const calls: Array<{ method: string; url: string; body?: unknown; auth?: string }> = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    calls.push({
      method: init.method ?? 'GET',
      url,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: (init.headers as Record<string, string>).Authorization,
    });
    for (const route of routes) {
      const r = route(url, init);
      if (r) return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200 });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const quiet = { sleep: async () => {}, log: () => {} };

describe('Azure DevOps e2e orchestration', () => {
  it('waits for the dev extension, queues the pipeline and succeeds', async () => {
    let polls = 0;
    let runPolls = 0;
    const { fetch, calls } = fakeFetch([
      (u, i) => (u.includes('installedextensionsbyname') && !i.method ? { body: { version: ++polls > 1 ? '0.4.4201' : '0.4.4100' } } : undefined),
      (u, i) => (u.includes('/pipelines/7/runs?') && i.method === 'POST' ? { body: { id: 42, state: 'inProgress', _links: { web: { href: 'https://run' } } } } : undefined),
      (u) => (u.includes('/pipelines/7/runs/42?') ? { body: { id: 42, state: ++runPolls > 1 ? 'completed' : 'inProgress', result: 'succeeded' } } : undefined),
    ]);
    const r = await runE2E(env, { fetch, ...quiet });
    expect(r).toEqual({ runId: 42, url: 'https://run' });
    const queue = calls.find((c) => c.method === 'POST')!;
    expect(queue.url).toBe('https://dev.azure.com/org/E2E%20Project/_apis/pipelines/7/runs?api-version=7.1');
    expect(queue.body).toEqual({
      resources: { repositories: { self: { refName: 'refs/heads/feature' } } },
      templateParameters: { acr: 'myacr.azurecr.io' },
    });
    expect(calls.every((c) => c.auth === 'Bearer tok')).toBe(true);
  });

  it('installs the dev extension when it is missing', async () => {
    let installed = false;
    const { fetch, calls } = fakeFetch([
      (u, i) => (u.includes('installedextensionsbyname/onek8s/container-build-dev/0.4.4201') && i.method === 'POST' ? ((installed = true), { body: {} }) : undefined),
      (u, i) => (u.includes('installedextensionsbyname') && !i.method && installed ? { body: { version: '0.4.4201' } } : undefined),
      (u, i) => (u.includes('/runs?') && i.method === 'POST' ? { body: { id: 1, state: 'completed', result: 'succeeded' } } : undefined),
    ]);
    await runE2E(env, { fetch, ...quiet });
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/container-build-dev/0.4.4201?'))).toBe(true);
  });

  it('reports failed steps of a failed run', async () => {
    const logs: string[] = [];
    const { fetch } = fakeFetch([
      (u) => (u.includes('installedextensionsbyname') ? { body: { version: '0.4.4201' } } : undefined),
      (u, i) => (u.includes('/runs?') && i.method === 'POST' ? { body: { id: 9, state: 'completed', result: 'failed', url: 'https://r' } } : undefined),
      (u) =>
        u.includes('/build/builds/9/timeline')
          ? { body: { records: [{ type: 'Task', name: 'ContainerBuildDev', result: 'failed', issues: [{ message: 'push denied' }] }] } }
          : undefined,
    ]);
    await expect(runE2E({ ...env, ADO_MANAGED_POOL: 'mdp' }, { fetch, sleep: async () => {}, log: (m: string) => logs.push(m) })).rejects.toThrow(
      /run 9 failed/,
    );
    expect(logs).toContain('::error title=Task ContainerBuildDev::push denied');
  });

  it('requires its settings', async () => {
    await expect(runE2E({ ...env, ADO_TOKEN: '' }, quiet)).rejects.toThrow(/ADO_TOKEN/);
  });
});

describe('dev extension variant', () => {
  it('gets its own identity and the given patch version', () => {
    const dev = toDevVariant(
      { id: 'container-build', name: 'Container Build', version: '0.4.0', publisher: 'onek8s', public: true },
      { id: 'x', name: 'ContainerBuild', friendlyName: 'Container Build', version: { Major: 0, Minor: 4, Patch: 0 } },
      4201,
    );
    expect(dev.version).toBe('0.4.4201');
    expect(dev.ext).toMatchObject({ id: DEV_EXTENSION_ID, version: '0.4.4201', public: false, publisher: 'onek8s' });
    expect(dev.task).toMatchObject({ id: DEV_TASK_ID, name: 'ContainerBuildDev', version: { Major: 0, Minor: 4, Patch: 4201 } });
  });
});
