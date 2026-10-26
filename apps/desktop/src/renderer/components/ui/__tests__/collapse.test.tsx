// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Collapse } from '../collapse';

// Chat content must mount/unmount in the same commit, without waiting for a
// transition event. Existing work-group tests do not cover shared wrapper state.
vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => false }));
afterEach(cleanup);
it('renders chat disclosure immediately, preserving open content across updates', () => {
  const view = render(<Collapse animate={false} open><input defaultValue="draft" /></Collapse>);
  const input = screen.getByRole('textbox') as HTMLInputElement;
  input.focus(); input.value = 'edited';
  view.rerender(<Collapse animate={false} open><input defaultValue="draft" /><p>late details</p></Collapse>);
  expect(screen.getByRole('textbox')).toBe(input);
  expect(input.value).toBe('edited');
  expect(document.activeElement).toBe(input);
  view.rerender(<Collapse animate={false} open={false}><input defaultValue="draft" /></Collapse>);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(view.container.childElementCount).toBe(0);
  view.rerender(<Collapse animate={false} open><p>restored</p></Collapse>);
  expect(screen.getByText('restored')).toBeTruthy();
});
it('keeps the default disclosure lifecycle for surfaces outside chat', () => {
  const view = render(<Collapse open><p>details</p></Collapse>);
  view.rerender(<Collapse open={false}><p>details</p></Collapse>);
  // Default animated close retains the outgoing body until its transition ends.
  expect(screen.getByText('details')).toBeTruthy();
});
