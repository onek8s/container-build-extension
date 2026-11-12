import type { AzureIdentity } from './azure';

/**
 * The only surface that differs between GitHub Actions and Azure DevOps.
 * Everything else (build, scan, push, tagging) lives in the shared core.
 */
export interface RegistryCredentials {
  registry: string;
  username: string;
  password: string;
  /** Where the credentials came from, for the log. */
  source?: string;
}

export interface BuildContext {
  /** Full commit SHA of the build, if known. */
  sha?: string;
  /** Git ref, e.g. refs/heads/main, refs/tags/v1.0.0, refs/pull/1/merge. */
  ref?: string;
  /** True when running for a pull request. */
  isPullRequest: boolean;
  /** Directory used for temporary files. */
  tempDir: string;
  /** Workspace / sources directory. */
  workspace: string;
  /** Source project / owner (GitHub owner, Azure DevOps project) used for automatic image names. */
  project?: string;
  /** Source repository name used for automatic image names. */
  repository?: string;
  /** Directory for downloaded tools that may be reused between jobs (defaults to tempDir). */
  toolCacheDir?: string;
}

export interface Platform {
  readonly name: string;
  /** Returns the trimmed input value, or undefined when not set/empty. Names are camelCase. */
  getInput(name: string): string | undefined;
  /** Pipeline/workflow variable or environment variable (incl. secret variables on Azure DevOps). */
  getVariable(name: string): string | undefined;
  /** Registry implied by the platform configuration (service connection, ghcr.io on GitHub). */
  getDefaultRegistry(): string | undefined;
  /** Explicitly configured credentials (inputs, service connection). */
  getCredentials(registry: string): RegistryCredentials | undefined;
  /** Platform-specific Entra identity for Azure Container Registry (service connection, GitHub OIDC). */
  getAzureIdentity?(registry: string): AzureIdentity | undefined;
  /** Credentials used when nothing is configured (e.g. GITHUB_TOKEN for ghcr.io). */
  getFallbackCredentials?(registry: string): RegistryCredentials | undefined;
  readonly context: BuildContext;

  debug(message: string): void;
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
  startGroup(name: string): void;
  endGroup(): void;
  setSecret(value: string): void;
  setOutput(name: string, value: string): void;
  addSummary(markdown: string): void;
  /** Publishes a file as a build artifact where the platform supports it from a task. */
  publishArtifact(name: string, file: string): void;
  setFailed(message: string): void;
}
