import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    // Move service connection secrets out of the environment so child processes don't inherit them.
    for (const key of Object.keys(env)) {
      if (key.toUpperCase().startsWith('ENDPOINT_')) {
        this.endpointVars.set(key.toUpperCase(), env[key] ?? '');
        if (key.toUpperCase().startsWith('ENDPOINT_AUTH')) delete env[key];
      }
    }
    this.context = {
      sha: env.BUILD_SOURCEVERSION,
      ref: env.BUILD_SOURCEBRANCH,
      isPullRequest: env.BUILD_REASON === 'PullRequest',
      tempDir: env.AGENT_TEMPDIRECTORY || os.tmpdir(),
      workspace: env.BUILD_SOURCESDIRECTORY || process.cwd(),
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

  getCredentials(registry: string): RegistryCredentials | undefined {
    const id = this.getInput('containerRegistry');
    if (!id) return undefined;

    const scheme = (this.endpoint('AUTH_SCHEME', id) ?? '').toLowerCase();
    const registryType = this.endpoint('DATA', id, 'registrytype');

    if (registryType === 'ACR' || scheme === 'serviceprincipal') {
      const loginServer = this.endpoint('AUTH_PARAMETER', id, 'loginServer') ?? registry;
      const username = this.endpoint('AUTH_PARAMETER', id, 'serviceprincipalid');
      const password = this.endpoint('AUTH_PARAMETER', id, 'serviceprincipalkey');
      if (!username || !password) {
        throw new Error(
          `Service connection uses authentication scheme '${scheme || 'unknown'}', which is not supported. ` +
            'Use an Azure Container Registry connection with a service principal, a "Docker Registry" connection ' +
            "with username/password, or run 'az acr login' in a previous step and leave containerRegistry empty.",
        );
      }
      return { registry: loginServer.toLowerCase(), username, password };
    }

    const username = this.endpoint('AUTH_PARAMETER', id, 'username');
    const password = this.endpoint('AUTH_PARAMETER', id, 'password');
    if (!username || !password) throw new Error(`Service connection '${id}' has no username/password`);
    const url = this.endpoint('AUTH_PARAMETER', id, 'registry') ?? this.endpoint('URL', id) ?? registry;
    return { registry: url, username, password };
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
  setFailed(message: string): void {
    this.error(message);
    this.command('task.complete', { result: 'Failed' }, message);
    process.exitCode = 1;
  }
}
