// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveRemoteText, type RemoteActionDescriptor } from '@cindy/device-link';
import { AgentActionForm } from './AgentAdaptersPage';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerGeneration: 1 }) }));
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    options,
    onValueChange,
    label,
    disabled,
  }: {
    value: string;
    options: { value: string; label: string }[];
    onValueChange(value: string): void;
    label: string;
    disabled: boolean;
  }) =>
    createElement(
      'select',
      {
        value,
        disabled,
        'aria-label': label,
        onChange: (event: { currentTarget: { value: string } }) =>
          onValueChange(event.currentTarget.value),
      },
      createElement('option', { value: '' }, 'Choose'),
      ...options.map((option) =>
        createElement('option', { key: option.value, value: option.value }, option.label),
      ),
    ),
}));
afterEach(cleanup);
/**
 * 测试价值：真实 AgentActionForm 的显式发送与权限选择；避免双击重复执行及丢回执后丢掉 requestId。
 * sessions 测试不覆盖控制端状态；最小输入：空输入、两次点击、回执未知、原生权限选项变化。
 * tier: unit；只替换平台 Select 展示，真实表单和提交控制保留。无真实等待。
 */
const send: RemoteActionDescriptor = {
  id: 'send',
  label: 'Send',
  fields: [{ id: 'text', label: 'Message', kind: 'multiline', required: true }],
};
const label = (text: Parameters<typeof resolveRemoteText>[0]) => resolveRemoteText(text, 'en');
describe('external Agent action form', () => {
  it('requires input and submits only once while its request is pending', async () => {
    let finish!: (value: boolean) => void;
    const invoke = vi.fn<(input: Record<string, unknown>) => Promise<boolean>>(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    render(<AgentActionForm action={send} label={label} disabled={false} invoke={invoke} />);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('button'));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      text: 'hello',
      requestId: expect.any(String),
    });
    await act(async () => finish(true));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });
  it('keeps the draft and idempotency receipt across an uncertain result and a read refresh', async () => {
    const invoke = vi.fn().mockResolvedValue(false);
    const props = { action: send, label, disabled: false, invoke };
    const view = render(<AgentActionForm {...props} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'work' } });
    await act(async () => fireEvent.click(screen.getByRole('button')));
    const first = invoke.mock.calls[0]?.[0];
    view.rerender(<AgentActionForm {...props} action={{ ...send }} />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('work');
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.click(screen.getByRole('button')));
    expect(invoke.mock.calls[1]?.[0]).toEqual(first);
  });
  it('requires an explicit currently valid native permission choice', () => {
    const invoke = vi.fn().mockResolvedValue(true);
    const action: RemoteActionDescriptor = {
      id: 'permission:1',
      label: 'Decide',
      fields: [
        {
          id: 'optionId',
          label: 'Choice',
          kind: 'select',
          required: true,
          options: [{ value: 'allow', label: 'Allow once' }],
        },
      ],
    };
    const view = render(
      <AgentActionForm action={action} label={label} disabled={false} invoke={invoke} />,
    );
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'allow' } });
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false);
    view.rerender(
      <AgentActionForm
        action={{ ...action, fields: [{ ...action.fields![0]!, options: [] }] }}
        label={label}
        disabled={false}
        invoke={invoke}
      />,
    );
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });
});
