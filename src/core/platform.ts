/**
 * The only surface that differs between GitHub Actions and Azure DevOps.
 * Everything else (build, scan, push, tagging) lives in the shared core.
 */
export interface RegistryCredentials {
  registry: string;
  username: string;
  password: string;
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
}

export interface Platform {
  readonly name: string;
  /** Returns the trimmed input value, or undefined when not set/empty. Names are camelCase. */
  getInput(name: string): string | undefined;
  /** Platform-specific way of resolving registry credentials (service connection, token...). */
  getCredentials(registry: string): RegistryCredentials | undefined;
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
  setFailed(message: string): void;
}
