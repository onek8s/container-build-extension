import { run } from '../core/run';
import { AzurePlatform } from './platform';

const platform = new AzurePlatform();
run(platform).catch((err: unknown) => platform.setFailed(err instanceof Error ? err.message : String(err)));
