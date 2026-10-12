import fs from 'node:fs';
import path from 'node:path';

export default class CiTimingReporter {
  onInit(ctx) {
    this.ctx = ctx;
    this.started = performance.now();
  }

  onTestRunEnd(modules, errors, reason) {
    if (!this.ctx.config.shard) return;
    const files = modules.map(module => {
      const diagnostic = module.diagnostic();
      return {
        file: path.relative(this.ctx.config.root, module.moduleId).replaceAll('\\', '/'),
        project: module.project.name,
        state: module.state(),
        tests: Array.from(module.children.allTests()).length,
        testMs: diagnostic.duration,
        collectMs: diagnostic.collectDuration,
        environmentMs: diagnostic.environmentSetupDuration,
        prepareMs: diagnostic.prepareDuration,
        setupMs: diagnostic.setupDuration,
      };
    });
    const report = {
      version: 1, platform: process.platform, shard: this.ctx.config.shard,
      wallMs: performance.now() - this.started, reason, unhandledErrors: errors.length, files,
    };
    const output = path.resolve(this.ctx.config.root, '../../tmp/ci-timings',
      `desktop-${process.platform}-${this.ctx.config.shard.index}.json`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    const slowest = [...files].sort((a, b) => b.testMs + b.collectMs - a.testMs - a.collectMs).slice(0, 10);
    // The workspace runner retains these summary lines on success as well.
    this.ctx.logger.log(`CI_TIMING ${files.length} files; wall ${(report.wallMs / 1000).toFixed(1)}s`);
    for (const file of slowest) this.ctx.logger.log(`CI_TIMING ${file.file}: tests=${Math.round(file.testMs)}ms collect=${Math.round(file.collectMs)}ms env=${Math.round(file.environmentMs)}ms`);
  }
}
