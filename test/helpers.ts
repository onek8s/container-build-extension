import type { BuildContext, Platform, RegistryCredentials } from '../src/core/platform';

export class FakePlatform implements Platform {
  readonly name = 'fake';
  outputs: Record<string, string> = {};
  secrets: string[] = [];
  logs: string[] = [];
  summary = '';
  failed?: string;

  constructor(
    public inputs: Record<string, string>,
    public context: BuildContext,
    public creds?: RegistryCredentials,
  ) {}

  getInput(name: string) {
    return this.inputs[name] || undefined;
  }
  getCredentials() {
    return this.creds;
  }
  debug() {}
  info(m: string) {
    this.logs.push(m);
  }
  warning(m: string) {
    this.logs.push(`WARN ${m}`);
  }
  error(m: string) {
    this.logs.push(`ERR ${m}`);
  }
  startGroup() {}
  endGroup() {}
  setSecret(v: string) {
    this.secrets.push(v);
  }
  setOutput(n: string, v: string) {
    this.outputs[n] = v;
  }
  addSummary(md: string) {
    this.summary += md;
  }
  artifacts: Array<[string, string]> = [];
  publishArtifact(n: string, f: string) {
    this.artifacts.push([n, f]);
  }
  setFailed(m: string) {
    this.failed = m;
  }
}
