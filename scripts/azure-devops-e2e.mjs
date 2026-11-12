// Runs the Azure DevOps end-to-end tests against the dev extension published by
// .github/workflows/azure-devops-e2e.yml:
//   1. waits until the test organization has the just-published dev extension version installed
//   2. queues the test pipeline (test/azure-devops/e2e.yml) for the commit under test
//   3. waits for the run and prints the failing steps if it fails
// Authentication: an Entra access token for Azure DevOps (ADO_TOKEN), obtained with GitHub OIDC.

const RESOURCE_EXTMGMT = (org) => `https://extmgmt.dev.azure.com/${org}/_apis/extensionmanagement`;
const RESOURCE_PROJECT = (org, project) => `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_apis`;

export async function runE2E(env, { fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log } = {}) {
  for (const name of ['ADO_TOKEN', 'ADO_ORGANIZATION', 'ADO_PROJECT', 'ADO_PIPELINE_ID', 'EXPECTED_VERSION', 'E2E_ACR', 'REF']) {
    if (!env[name]) throw new Error(`${name} is not set`);
  }
  const org = env.ADO_ORGANIZATION;
  const publisher = env.PUBLISHER ?? 'onek8s';
  const extensionId = env.EXTENSION_ID ?? 'container-build-dev';
  const headers = { Authorization: `Bearer ${env.ADO_TOKEN}`, 'Content-Type': 'application/json' };

  async function api(url, init = {}) {
    const r = await fetch(url, { ...init, headers });
    const text = await r.text();
    if (r.status === 404 && init.allow404) return undefined;
    if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${url.split('?')[0]} failed: HTTP ${r.status} ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : {};
  }

  // 1. dev extension version
  const ext = `${RESOURCE_EXTMGMT(org)}/installedextensionsbyname/${publisher}/${extensionId}`;
  const deadline = Date.now() + Number(env.INSTALL_TIMEOUT_MS ?? 15 * 60_000);
  let reinstalled = false;
  for (;;) {
    const installed = await api(`${ext}?api-version=7.1-preview.1`, { allow404: true });
    if (installed?.version === env.EXPECTED_VERSION) {
      log(`${publisher}.${extensionId} ${installed.version} is installed in ${org}`);
      break;
    }
    if (!installed || (!reinstalled && Date.now() > deadline - Number(env.REINSTALL_AFTER_MS ?? 10 * 60_000))) {
      // not installed yet, or the update is slow: (re)install the shared dev extension
      if (installed) await api(`${ext}?api-version=7.1-preview.1`, { method: 'DELETE' });
      log(`Installing ${publisher}.${extensionId} ${env.EXPECTED_VERSION} in ${org}`);
      await api(`${ext}/${env.EXPECTED_VERSION}?api-version=7.1-preview.1`, { method: 'POST' });
      reinstalled = true;
    } else {
      log(`Waiting for ${env.EXPECTED_VERSION} (installed: ${installed.version})`);
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${extensionId} ${env.EXPECTED_VERSION} in ${org}`);
    await sleep(15_000);
  }

  // 2. queue the test pipeline
  const project = RESOURCE_PROJECT(org, env.ADO_PROJECT);
  const templateParameters = { acr: env.E2E_ACR };
  if (env.ADO_MANAGED_POOL) templateParameters.managedPool = env.ADO_MANAGED_POOL;
  const run = await api(`${project}/pipelines/${env.ADO_PIPELINE_ID}/runs?api-version=7.1`, {
    method: 'POST',
    body: JSON.stringify({ resources: { repositories: { self: { refName: env.REF } } }, templateParameters }),
  });
  const url = run._links?.web?.href ?? run.url;
  log(`Queued run ${run.id}: ${url}`);

  // 3. wait for the result
  const runDeadline = Date.now() + Number(env.RUN_TIMEOUT_MS ?? 45 * 60_000);
  let state = run;
  while (state.state !== 'completed') {
    if (Date.now() > runDeadline) throw new Error(`Timed out waiting for run ${run.id}: ${url}`);
    await sleep(20_000);
    state = await api(`${project}/pipelines/${env.ADO_PIPELINE_ID}/runs/${run.id}?api-version=7.1`);
  }
  log(`Run ${run.id} ${state.result}: ${url}`);
  if (state.result !== 'succeeded') {
    const timeline = await api(`${project}/build/builds/${run.id}/timeline?api-version=7.1`, { allow404: true });
    for (const rec of timeline?.records ?? []) {
      if (rec.result !== 'failed') continue;
      log(`::error title=${rec.type} ${rec.name}::${(rec.issues ?? []).map((i) => i.message).join(' | ') || 'failed'}`);
    }
    throw new Error(`Azure DevOps e2e run ${run.id} ${state.result}: ${url}`);
  }
  return { runId: run.id, url };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runE2E(process.env).catch((err) => {
    console.log(`::error::${err.message}`);
    process.exitCode = 1;
  });
}
