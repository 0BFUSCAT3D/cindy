import fs from 'node:fs';
import path from 'node:path';
import { BaseSequencer } from 'vitest/node';
import { partitionByTiming } from '../../../scripts/shared/timing-shards.mjs';

// A checked-in snapshot is identical in every job. Independently restored live
// caches could assign a file to both shards (or neither) during concurrent runs.
const snapshot = JSON.parse(fs.readFileSync(new URL('./unit-test-timings.json', import.meta.url), 'utf8'));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export default class TimingSequencer extends BaseSequencer {
  key(file) {
    return `${file.project.name}:${path.relative(this.ctx.config.root, file.moduleId).replaceAll('\\', '/')}`;
  }

  weight(file) {
    const relative = path.relative(this.ctx.config.root, file.moduleId).replaceAll('\\', '/');
    // Include collection, DOM setup and harness preparation: on CI these cost
    // more than the assertions. New files use a conservative loading estimate.
    const durations = snapshot.durationMsByPlatform[process.platform] ?? snapshot.durationMsByPlatform.linux;
    return snapshot.fileOverheadMs + (durations[relative] ?? snapshot.defaultDurationMs);
  }

  async shard(files) {
    const { index, count } = this.ctx.config.shard;
    // Weights are cumulative worker time; workflow overhead is wall time.
    const workers = this.ctx.config.maxWorkers;
    const overhead = (process.env.XDT_DESKTOP_SHARD_OVERHEAD_MS ?? '').split(',').filter(Boolean)
      .map(value => Number(value) * workers);
    if (overhead.length && overhead.length !== count) throw new Error('Desktop shard overhead must match shard count');
    return partitionByTiming(files, {
      count, key: file => this.key(file), weight: file => this.weight(file), overhead,
    })[index - 1];
  }

  async sort(files) {
    if (!this.ctx.config.shard) return super.sort(files);
    // Start long files early so they cannot strand a worker at the end of CI.
    return [...files].sort((a, b) => this.weight(b) - this.weight(a) || compare(this.key(a), this.key(b)));
  }
}
