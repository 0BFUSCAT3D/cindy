/**
 * 组策略(provider-groups.md §5)：只分给可用、未暂停、没试过的电脑；优先未满载；四种选择方式。
 */
import { describe, expect, it } from 'vitest';

import { pickProviderGroupMember, type SchedulableMember } from '../scheduler';

const m = (key: string, patch: Partial<SchedulableMember> = {}): SchedulableMember => ({
  key,
  usable: true,
  paused: false,
  running: 0,
  limit: 4,
  weight: 1,
  ...patch,
});

describe('pickProviderGroupMember', () => {
  it('skips unusable, paused and already-tried computers', () => {
    const members = [m('a', { usable: false }), m('b', { paused: true }), m('c'), m('d')];
    expect(pickProviderGroupMember(members, 'order')).toBe('c');
    expect(pickProviderGroupMember(members, 'order', { exclude: new Set(['c']) })).toBe('d');
    expect(pickProviderGroupMember(members, 'order', { exclude: new Set(['c', 'd']) })).toBeNull();
  });

  it('puts computers that failed recently behind the rest, so a computer that never takes a task is not always picked first', () => {
    // 一直接不下任务的那台运行数最少：最少占用 / 按顺序都不再先选它。
    const members = [m('broken', { suspect: true }), m('a', { running: 2 }), m('b', { running: 1 })];
    expect(pickProviderGroupMember(members, 'least')).toBe('b');
    expect(pickProviderGroupMember(members, 'order')).toBe('a');
    // 没失败过的都满了：先试有空位的那台，再不行才分给最空的。
    expect(pickProviderGroupMember([m('broken', { suspect: true }), m('a', { running: 4 })], 'least')).toBe('broken');
    expect(pickProviderGroupMember([m('broken', { suspect: true, running: 5 }), m('a', { running: 4 })], 'least')).toBe('a');
    // 只剩它时照样分给它。
    expect(pickProviderGroupMember([m('broken', { suspect: true })], 'least')).toBe('broken');
  });

  it('least busy picks the computer running the fewest tasks, ties by list order', () => {
    expect(pickProviderGroupMember([m('a', { running: 2 }), m('b', { running: 1 }), m('c', { running: 1 })], 'least')).toBe('b');
  });

  it('prefers computers under their limit and falls back to the least busy when all are full', () => {
    const members = [m('a', { running: 4 }), m('b', { running: 3 })];
    expect(pickProviderGroupMember(members, 'order')).toBe('b');
    expect(pickProviderGroupMember([m('a', { running: 5 }), m('b', { running: 4 })], 'order')).toBe('b');
  });

  it('round robin continues after the last picked computer and wraps around', () => {
    const members = [m('a'), m('b'), m('c')];
    expect(pickProviderGroupMember(members, 'round', { lastPicked: null })).toBe('a');
    expect(pickProviderGroupMember(members, 'round', { lastPicked: 'a' })).toBe('b');
    expect(pickProviderGroupMember(members, 'round', { lastPicked: 'c' })).toBe('a');
  });

  it('weight splits by the given weights', () => {
    const members = [m('a', { weight: 1 }), m('b', { weight: 3 })];
    expect(pickProviderGroupMember(members, 'weight', { random: () => 0.1 })).toBe('a');
    expect(pickProviderGroupMember(members, 'weight', { random: () => 0.5 })).toBe('b');
  });
});
