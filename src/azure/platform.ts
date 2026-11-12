import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AzureIdentity } from '../core/azure';
import { exec as defaultExec, type Exec } from '../core/exec';
import { httpRequest } from '../core/http';
import type { BuildContext, Platform, RegistryCredentials } from '../core/platform';

function escapeData(s: string): string {
  return s.replace(/%/g, '%AZP25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function escapeProperty(s: string): string {
  return escapeData(s).replace(/]/g, '%5D').replace(/;/g, '%3B');
}

/**
 * Azure Pipelines adapter. Implements the ##vso logging command protocol directly
 * (no azure-pipelines-task-lib dependency) so the task is a single self-contained file.
 */
export class AzurePlatform implements Platform {
  readonly name = 'Azure Pipelines';
  readonly context: BuildContext;
  private readonly endpointVars = new Map<string, string>();
  private readonly secretVars = new Map<string, string>();

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly exec: Exec = defaultExec,
  ) {
    // Move service connection secrets out of the environment so child processes don't inherit them.
    for (const key of Object.keys(env)) {
      if (key.toUpperCase().startsWith('ENDPOINT_')) {
        this.endpointVars.set(key.toUpperCase(), env[key] ?? '');
        if (key.toUpperCase().startsWith('ENDPOINT_AUTH')) delete env[key];
      }
      // The agent passes secret pipeline variables to tasks as SECRET_<NAME>
      if (key.startsWith('SECRET_')) {
        this.secretVars.set(key.substring('SECRET_'.length), env[key] ?? '');
        delete env[key];
      }
    }
    const repo = env.BUILD_REPOSITORY_NAME?.split('/').pop();
    this.context = {
      project: env.SYSTEM_TEAMPROJECT || undefined,
      repository: repo || undefined,
      attempt: Number(env.SYSTEM_JOBATTEMPT) || undefined,
      sha: env.BUILD_SOURCEVERSION,
      ref: env.BUILD_SOURCEBRANCH,
      isPullRequest: env.BUILD_REASON === 'PullRequest',
      tempDir: env.AGENT_TEMPDIRECTORY || os.tmpdir(),
      workspace: env.BUILD_SOURCESDIRECTORY || process.cwd(),
      toolCacheDir: env.AGENT_TOOLSDIRECTORY || undefined,
    };
  }

  getInput(name: string): string | undefined {
    const value = this.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`]?.trim();
    return value ? value : undefined;
  }

  private endpoint(kind: 'URL' | 'AUTH_SCHEME' | 'AUTH_PARAMETER' | 'DATA', id: string, key?: string): string | undefined {
    const name = ['ENDPOINT', kind, id, key].filter(Boolean).join('_').toUpperCase();
    const value = this.endpointVars.get(name);
    return value ? value : undefined;
  }

  getVariable(name: string): string | undefined {
    const key = name.replace(/[. ]/g, '_').toUpperCase();
    const value = (this.env[key] ?? this.secretVars.get(key))?.trim();
    return value ? value : undefined;
  }

  /** The registry of the selected service connection. */
  getDefaultRegistry(): string | undefined {
    const id = this.getInput('containerRegistry');
    if (!id) return undefined;
    return (
      this.endpoint('AUTH_PARAMETER', id, 'loginServer') ??
      this.endpoint('AUTH_PARAMETER', id, 'registry') ??
      this.endpoint('URL', id)
    );
  }

  getCredentials(registry: string): RegistryCredentials | undefined {
    const id = this.getInput('containerRegistry');
    if (!id) return undefined;

    const scheme = (this.endpoint('AUTH_SCHEME', id) ?? '').toLowerCase();
    const registryType = this.endpoint('DATA', id, 'registrytype');

    if (registryType === 'ACR' || scheme === 'serviceprincipal') {
      // workload identity federation / managed identity connections are handled by getAzureIdentity
      if (scheme === 'workloadidentityfederation' || scheme === 'managedserviceidentity') return undefined;
      const loginServer = this.endpoint('AUTH_PARAMETER', id, 'loginServer') ?? registry;
      const username = this.endpoint('AUTH_PARAMETER', id, 'serviceprincipalid');
      const password = this.endpoint('AUTH_PARAMETER', id, 'serviceprincipalkey');
      if (!username || !password) {
        throw new Error(`Service connection uses authentication scheme '${scheme || 'unknown'}', which is not supported.`);
      }
      return { registry: loginServer.toLowerCase(), username, password, source: 'service connection' };
    }

    const username = this.endpoint('AUTH_PARAMETER', id, 'username');
    const password = this.endpoint('AUTH_PARAMETER', id, 'password');
    if (!username || !password) throw new Error(`Service connection '${id}' has no username/password`);
    const url = this.endpoint('AUTH_PARAMETER', id, 'registry') ?? this.endpoint('URL', id) ?? registry;
    return { registry: url, username, password, source: 'service connection' };
  }

  /**
   * Entra identity from a Docker Registry (Azure Container Registry) or Azure Resource Manager service
   * connection using workload identity federation, managed identity or a service principal secret.
   */
  getAzureIdentity(): AzureIdentity | undefined {
    for (const input of ['containerRegistry', 'azureSubscription']) {
      const id = this.getInput(input);
      if (!id) continue;
      const scheme = (this.endpoint('AUTH_SCHEME', id) ?? '').toLowerCase();
      if (input === 'containerRegistry' && this.endpoint('DATA', id, 'registrytype') !== 'ACR') continue;
      const tenantId = this.endpoint('AUTH_PARAMETER', id, 'tenantid');
      const clientId = this.endpoint('AUTH_PARAMETER', id, 'serviceprincipalid');
      const authorityHost = this.endpoint('DATA', id, 'environmentAuthorityUrl');
      const source = `service connection '${input}' (${scheme || 'unknown scheme'})`;

      if (scheme === 'managedserviceidentity') return { kind: 'managed', source };
      if (!tenantId || !clientId) {
        if (input === 'containerRegistry') continue; // username/password ACR connection
        throw new Error(`Service connection '${input}' has no tenant or service principal id`);
      }
      if (scheme === 'workloadidentityfederation') {
        return { kind: 'federated', source, tenantId, clientId, authorityHost, getAssertion: () => this.oidcToken(id) };
      }
      const clientSecret = this.endpoint('AUTH_PARAMETER', id, 'serviceprincipalkey');
      if (input === 'azureSubscription' && scheme === 'serviceprincipal' && clientSecret) {
        return { kind: 'secret', source, tenantId, clientId, clientSecret, authorityHost };
      }
      if (input === 'azureSubscription') {
        throw new Error(`Authentication scheme '${scheme}' of service connection '${input}' is not supported.`);
      }
    }
    return undefined;
  }

  /** Requests the OIDC token of a workload identity federation service connection for this job. */
  private async oidcToken(serviceConnectionId: string): Promise<string> {
    const accessToken = this.endpoint('AUTH_PARAMETER', 'SYSTEMVSSCONNECTION', 'ACCESSTOKEN') ?? this.env.SYSTEM_ACCESSTOKEN;
    if (!accessToken) throw new Error('System.AccessToken is not available to the task');
    let url = this.env.SYSTEM_OIDCREQUESTURI;
    if (!url) {
      const e = this.env;
      url = `${(e.SYSTEM_COLLECTIONURI ?? '').replace(/\/+$/, '')}/${e.SYSTEM_TEAMPROJECTID}/_apis/distributedtask/hubs/${e.SYSTEM_HOSTTYPE}/plans/${e.SYSTEM_PLANID}/jobs/${e.SYSTEM_JOBID}/oidctoken`;
    }
    const r = await httpRequest<{ oidcToken?: string }>(this.exec, {
      url: `${url}?api-version=7.1&serviceConnectionId=${encodeURIComponent(serviceConnectionId)}`,
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      json: {},
    });
    if (!r.oidcToken) throw new Error('Azure DevOps did not return an OIDC token for the service connection');
    return r.oidcToken;
  }

  private command(name: string, props: Record<string, string>, message: string): void {
    const p = Object.entries(props)
      .map(([k, v]) => `${k}=${escapeProperty(v)}`)
      .join(';');
    process.stdout.write(`##vso[${name}${p ? ` ${p}` : ''}]${escapeData(message)}${os.EOL}`);
  }

  debug(message: string): void {
    process.stdout.write(`##[debug]${message}${os.EOL}`);
  }
  info(message: string): void {
    process.stdout.write(`${message}${os.EOL}`);
  }
  warning(message: string): void {
    this.command('task.logissue', { type: 'warning' }, message);
  }
  error(message: string): void {
    this.command('task.logissue', { type: 'error' }, message);
  }
  startGroup(name: string): void {
    process.stdout.write(`##[group]${name}${os.EOL}`);
  }
  endGroup(): void {
    process.stdout.write(`##[endgroup]${os.EOL}`);
  }
  setSecret(value: string): void {
    this.command('task.setsecret', {}, value);
  }
  setOutput(name: string, value: string): void {
    this.command('task.setvariable', { variable: name, isOutput: 'true' }, value);
  }
  addSummary(markdown: string): void {
    const file = path.join(this.context.tempDir, `container-build-summary-${Date.now()}.md`);
    fs.writeFileSync(file, markdown);
    this.command('task.uploadsummary', {}, file);
  }
  publishArtifact(name: string, file: string): void {
    this.command('artifact.upload', { containerfolder: name, artifactname: name }, file);
  }
  setFailed(message: string): void {
    this.error(message);
    this.command('task.complete', { result: 'Failed' }, message);
    process.exitCode = 1;
  }
}
