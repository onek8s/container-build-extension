import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Exec } from './exec';

/** True when the docker client config already holds credentials for the registry. */
export function hasDockerLogin(registry: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const file = path.join(env.DOCKER_CONFIG || path.join(os.homedir(), '.docker'), 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      auths?: Record<string, unknown>;
      credHelpers?: Record<string, string>;
    };
    const host = (k: string) => k.replace(/^[a-z]+:\/\//, '').split('/')[0].toLowerCase();
    return (
      Object.keys(config.auths ?? {}).some((k) => host(k) === registry) ||
      Object.keys(config.credHelpers ?? {}).some((k) => host(k) === registry)
    );
  } catch {
    return false;
  }
}
import type { RegistryCredentials } from './platform';

export class Docker {
  constructor(private readonly exec: Exec) {}

  async version(): Promise<string> {
    const r = await this.exec('docker', ['version', '--format', '{{.Server.Version}}'], { silent: true });
    return r.stdout.trim();
  }

  async login(creds: RegistryCredentials): Promise<void> {
    await this.exec('docker', ['login', creds.registry, '--username', creds.username, '--password-stdin'], {
      input: creds.password,
      silent: true,
    });
  }

  async logout(registry: string): Promise<void> {
    await this.exec('docker', ['logout', registry], { silent: true, ignoreReturnCode: true });
  }

  async build(opts: {
    context: string;
    dockerfile: string;
    imageRefs: string[];
    buildArgs: string[];
    target?: string;
    labels: Record<string, string>;
    buildContexts?: Record<string, string>;
  }): Promise<void> {
    const args = ['build', '--file', opts.dockerfile];
    for (const ref of opts.imageRefs) args.push('--tag', ref);
    for (const arg of opts.buildArgs) args.push('--build-arg', arg);
    for (const [k, v] of Object.entries(opts.labels)) args.push('--label', `${k}=${v}`);
    if (opts.target) args.push('--target', opts.target);
    for (const [name, dir] of Object.entries(opts.buildContexts ?? {})) args.push('--build-context', `${name}=${dir}`);
    args.push(opts.context);
    await this.exec('docker', args, { env: { ...process.env, DOCKER_BUILDKIT: '1' } });
  }

  async push(imageRef: string): Promise<void> {
    await this.exec('docker', ['push', imageRef]);
  }

  /** Returns the registry digest (sha256:...) of a pushed image, if available. */
  async repoDigest(repository: string, imageRef: string): Promise<string | undefined> {
    const r = await this.exec('docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}', imageRef], {
      silent: true,
      ignoreReturnCode: true,
    });
    if (r.exitCode !== 0) return undefined;
    try {
      const digests = JSON.parse(r.stdout.trim()) as string[];
      const match = digests.find((d) => d.split('@')[0] === repository) ?? digests[0];
      return match?.split('@')[1];
    } catch {
      return undefined;
    }
  }
}
