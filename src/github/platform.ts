import * as fs from 'node:fs';
import * as os from 'node:os';
import type { BuildContext, Platform, RegistryCredentials } from '../core/platform';

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function escapeData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** GitHub Actions adapter. Implements the workflow command protocol directly (no runtime dependencies). */
export class GitHubPlatform implements Platform {
  readonly name = 'GitHub Actions';
  readonly context: BuildContext;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    this.context = {
      sha: env.GITHUB_SHA,
      ref: env.GITHUB_REF,
      isPullRequest: ['pull_request', 'pull_request_target'].includes(env.GITHUB_EVENT_NAME ?? ''),
      tempDir: env.RUNNER_TEMP || os.tmpdir(),
      workspace: env.GITHUB_WORKSPACE || process.cwd(),
      toolCacheDir: env.RUNNER_TOOL_CACHE || undefined,
    };
  }

  getInput(name: string): string | undefined {
    const key = `INPUT_${kebab(name).replace(/ /g, '_').toUpperCase()}`;
    const value = this.env[key]?.trim();
    return value ? value : undefined;
  }

  getCredentials(registry: string): RegistryCredentials | undefined {
    const username = this.getInput('username');
    const password = this.getInput('password');
    if (password) {
      if (!username) throw new Error("Input 'username' is required when 'password' is set");
      return { registry, username, password };
    }
    // Zero-config GitHub Container Registry: use the workflow token.
    const token = this.getInput('githubToken');
    if (registry === 'ghcr.io' && token) {
      return { registry, username: username ?? this.env.GITHUB_ACTOR ?? 'github-actions', password: token };
    }
    return undefined;
  }

  debug(message: string): void {
    process.stdout.write(`::debug::${escapeData(message)}${os.EOL}`);
  }
  info(message: string): void {
    process.stdout.write(`${message}${os.EOL}`);
  }
  warning(message: string): void {
    process.stdout.write(`::warning::${escapeData(message)}${os.EOL}`);
  }
  error(message: string): void {
    process.stdout.write(`::error::${escapeData(message)}${os.EOL}`);
  }
  startGroup(name: string): void {
    process.stdout.write(`::group::${escapeData(name)}${os.EOL}`);
  }
  endGroup(): void {
    process.stdout.write(`::endgroup::${os.EOL}`);
  }
  setSecret(value: string): void {
    for (const line of value.split(/\r?\n/)) if (line) process.stdout.write(`::add-mask::${escapeData(line)}${os.EOL}`);
  }
  setOutput(name: string, value: string): void {
    const file = this.env.GITHUB_OUTPUT;
    const key = kebab(name);
    if (!file) {
      this.debug(`output ${key}=${value}`);
      return;
    }
    const delimiter = `ghadelimiter_${Math.random().toString(36).slice(2)}`;
    fs.appendFileSync(file, `${key}<<${delimiter}${os.EOL}${value}${os.EOL}${delimiter}${os.EOL}`);
  }
  addSummary(markdown: string): void {
    const file = this.env.GITHUB_STEP_SUMMARY;
    if (file) fs.appendFileSync(file, `${markdown}${os.EOL}`);
  }
  publishArtifact(): void {
    // JavaScript actions cannot upload artifacts without the artifact service SDK;
    // the file path is exposed as an output instead (use actions/upload-artifact).
  }
  setFailed(message: string): void {
    this.error(message);
    process.exitCode = 1;
  }
}
