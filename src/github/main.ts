import { run } from '../core/run';
import { GitHubPlatform } from './platform';

const platform = new GitHubPlatform();
run(platform).catch((err: unknown) => platform.setFailed(err instanceof Error ? err.message : String(err)));
