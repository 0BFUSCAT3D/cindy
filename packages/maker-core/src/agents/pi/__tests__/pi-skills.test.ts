/**
 * PiAgent.listAgentSkills 单测 —— 纯文件系统技能发现(不 spawn pi 二进制)。
 *
 * 验证 pi 的 ChatInput `/` palette agent-skill 类目能扫到项目 .pi/skills 下的
 * SKILL.md,与 CC/Codex 的技能可见性对齐;发现层零基线上下文(仅 name/description)。
 */

import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PiAgent } from '../index.js';
import type { AgentDeps } from '../../base-agent.js';
import type { Logger } from '../../../interfaces/logger.js';

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

function buildDeps(): AgentDeps {
  return {
    auth: {
      getState: async () => ({ authenticated: true, identity: 'test', authSource: 'api-key' as const }),
      triggerLogin: async () => ({ authenticated: true }),
      logout: async () => {},
      getAuthEnv: async () => ({}),
    },
    runtimeConfig: { endpoint: '' },
    binaryPath: '/dummy/pi-not-spawned',
    logger: noopLogger,
    capabilityAdditions: { availableModels: [] },
  };
}

describe('PiAgent.listAgentSkills (filesystem discovery, no binary spawn)', () => {
  let workingDir = '';
  beforeEach(() => {
    workingDir = mkdtempSync(path.join(tmpdir(), 'pi-skills-'));
    vi.spyOn(os, 'homedir').mockReturnValue(workingDir);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workingDir, { recursive: true, force: true });
  });

  it('discovers a project-scoped skill from .pi/skills/<name>/SKILL.md as unavailable', async () => {
    const skillDir = path.join(workingDir, '.pi', 'skills', 'demo-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: demo-skill\ndescription: A demo skill for pi\n---\n# Demo\nbody\n',
    );

    const agent = new PiAgent(buildDeps());
    const result = await agent.listAgentSkills({ workingDir });

    const found = result.skills.find((s) => s.name === 'demo-skill');
    expect(found).toBeDefined();
    expect(found?.kind).toBe('agent-skill');
    expect(found?.source).toBe('skill');
    expect(found?.scope).toBe('repo');
    expect(found?.runtimeStatus).toBe('discovered');
    expect(found?.runtimeCommandName).toBe('skill:demo-skill');
    expect(found?.path).toBe(realpathSync(path.join(skillDir, 'SKILL.md')));
    expect(found?.description).toContain('demo skill');
  });

  it('returns a skills array without throwing when the project has no skill dirs', async () => {
    const agent = new PiAgent(buildDeps());
    const result = await agent.listAgentSkills({ workingDir });
    expect(result.skills).toEqual([]);
  });

  it.each([true, false])('keeps one managed entry and its enabled=%s state when discovery follows a symlink to it', async (enabled) => {
    const source = path.join(workingDir, 'managed', 'shared');
    const sharedRoot = path.join(workingDir, '.agents', 'skills');
    mkdirSync(source, { recursive: true });
    mkdirSync(sharedRoot, { recursive: true });
    const entry = path.join(source, 'SKILL.md');
    writeFileSync(entry, '---\nname: shared\ndescription: scanned description\n---\n');
    symlinkSync(source, path.join(sharedRoot, 'shared'), process.platform === 'win32' ? 'junction' : 'dir');
    const managed = {
      kind: 'agent-skill' as const, source: 'skill' as const, scope: 'user' as const,
      name: 'shared', description: 'managed description', path: entry, enabled,
      claudeCommandName: 'managed-shared',
    };
    const agent = new PiAgent({ ...buildDeps(), getManagedSkills: async () => [managed] });

    const result = await agent.listAgentSkills({ workingDir });

    expect(result.skills).toEqual([{
      kind: 'agent-skill', source: 'skill', scope: 'user',
      name: 'shared', description: 'managed description', path: entry, enabled,
      runtimeCommandName: 'skill:shared',
    }]);
  });

  it('deduplicates overlapping package paths without hiding same-name skills from different files', async () => {
    const source = path.join(workingDir, '.pi', 'skills', 'shared');
    mkdirSync(source, { recursive: true });
    const entry = path.join(source, 'SKILL.md');
    writeFileSync(entry, '---\nname: shared\ndescription: project skill\n---\n');
    const managedEntry = path.join(workingDir, 'managed', 'SKILL.md');
    const uniquePackage = path.join(workingDir, 'package', 'SKILL.md');
    const agent = new PiAgent({
      ...buildDeps(),
      getManagedSkills: async () => [{
        kind: 'agent-skill', source: 'skill', scope: 'user',
        name: 'shared', path: managedEntry, enabled: true, claudeCommandName: 'managed-shared',
      }],
      resolvePiManagedPackageResources: async () => ({
        extensions: [], promptTemplates: [], packageRoots: [workingDir],
        skills: [
          { name: 'shared', path: managedEntry },
          { name: 'shared', path: entry },
          { name: 'package-only', path: uniquePackage },
        ],
      }),
    });

    const result = await agent.listAgentSkills({ workingDir, includeManagedPiPackages: true });

    expect(result.skills.map((skill) => skill.path)).toEqual([uniquePackage, managedEntry, entry]);
    expect(result.skills.filter((skill) => skill.name === 'shared')).toHaveLength(2);
    expect(result.skills.find((skill) => skill.path === entry)).toMatchObject({
      origin: 'package', runtimeStatus: 'approved', runtimeCommandName: 'skill:shared',
    });
    expect(result.skills.find((skill) => skill.path === uniquePackage)).toMatchObject({
      origin: 'package', runtimeStatus: 'approved', runtimeCommandName: 'skill:package-only',
    });
  });

  it('includes Cindy-managed package skills only when the host explicitly allows them', async () => {
    const resolver = vi.fn(async () => ({
      extensions: [],
      skills: [{ path: '/managed/sample/SKILL.md', name: 'managed-sample' }],
      promptTemplates: [],
      packageRoots: ['/managed/sample'],
    }));
    const agent = new PiAgent({ ...buildDeps(), resolvePiManagedPackageResources: resolver });

    const isolated = await agent.listAgentSkills({
      workingDir,
      includeManagedPiPackages: false,
    });
    expect(isolated.skills.some((skill) => skill.name === 'managed-sample')).toBe(false);
    expect(resolver).not.toHaveBeenCalled();

    const ordinary = await agent.listAgentSkills({
      workingDir,
      includeManagedPiPackages: true,
    });
    expect(ordinary.skills).toContainEqual(expect.objectContaining({
      name: 'managed-sample',
      runtimeStatus: 'approved',
      origin: 'package',
      enabled: true,
      runtimeCommandName: 'skill:managed-sample',
    }));
    expect(resolver).toHaveBeenCalledOnce();
  });
});
