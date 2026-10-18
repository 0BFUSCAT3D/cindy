// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'test-owner' } }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { RichAnswer } from '../RichAnswer';
afterEach(cleanup);
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    disconnect() {}
  },
);
const line = (seq: number, op: Record<string, unknown>) => JSON.stringify({ seq, ...op }) + '\n';
// Tier 1: mount the production renderer; input identity/state must survive
// streamed patches, the final marker, and message-list virtualization.
it('preserves edited controls through patches, finalization and remount', () => {
  const source =
    line(1, {
      op: 'create',
      id: 'name',
      kind: 'input',
      props: { label: 'Name', default: 'Original' },
    }) + line(2, { op: 'create', id: 'note', kind: 'text', props: { text: 'Before' } });
  const props = { stateKey: 'stream-state', renderMarkdown: (text: string) => <span>{text}</span> };
  const view = render(<RichAnswer {...props} source={source} complete={false} />);
  const input = screen.getByLabelText('Name');
  fireEvent.change(input, { target: { value: 'Edited' } });
  const updated =
    source +
    line(3, { op: 'patch', id: 'name', props: { default: 'New default' } }) +
    line(4, { op: 'append', id: 'note', text: ' and after' });
  view.rerender(<RichAnswer {...props} source={updated} complete={true} />);
  expect(screen.getByLabelText('Name')).toBe(input);
  expect((input as HTMLInputElement).value).toBe('Edited');
  // Immediate reload must save the edit before the debounce fires.
  fireEvent(window, new Event('pagehide'));
  const saved = JSON.parse(localStorage.getItem('cindy.richAnswer.viewState.v1')!);
  expect(saved.entries.find(([key]: [string]) => key === 'test-owner:stream-state')[1].name).toBe(
    'Edited',
  );
  expect(screen.getByText('Before and after')).toBeTruthy();
  view.unmount();
  render(<RichAnswer {...props} source={updated} complete />);
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Edited');
});
it('routes image media through the host renderer without evaluating generated markup', () => {
  const source =
    line(1, {
      op: 'create',
      id: 'image',
      kind: 'image',
      props: { src: 'library:assets/a.png', alt: 'Preview' },
    }) +
    line(2, {
      op: 'create',
      id: 'text',
      kind: 'text',
      props: { text: '<script>throw 1</script>' },
    });
  const renderMarkdown = vi.fn((text: string) => <span>{text}</span>);
  const view = render(
    <RichAnswer stateKey="media" source={source} complete renderMarkdown={renderMarkdown} />,
  );
  expect(renderMarkdown).toHaveBeenCalledWith('![Preview](<library:assets/a.png>)', 'image');
  expect(view.container.querySelector('script')).toBeNull();
  expect(screen.getByText('<script>throw 1</script>')).toBeTruthy();
});
// Tier 1: a referenced result may arrive after its consumer in a live answer.
// Pending/error states must not erase readable content or misrepresent a total.
it('renders pending calculated references, resolves them and isolates invalid final values', () => {
  const first =
    line(1, {
      op: 'create',
      id: 'total',
      kind: 'stat',
      props: { label: 'Total', value: { ref: 'price' } },
    }) +
    line(2, { op: 'create', id: 'note', kind: 'text', props: { text: 'Existing explanation' } });
  const props = {
    stateKey: 'forward-reference',
    renderMarkdown: (text: string) => <span>{text}</span>,
  };
  const view = render(<RichAnswer {...props} source={first} complete={false} />);
  expect(screen.getByRole('status').textContent).toBe('…');
  view.rerender(
    <RichAnswer
      {...props}
      source={first + line(3, { op: 'create', id: 'price', kind: 'stat', props: { value: 25 } })}
      complete
    />,
  );
  expect(screen.queryByText('…')).toBeNull();
  expect(screen.getAllByText('25')).toHaveLength(2);
  view.rerender(<RichAnswer {...props} source={first} complete />);
  expect(screen.getByRole('status').textContent).toBe('richAnswer.calculationUnavailable');
  expect(screen.getByText('Existing explanation')).toBeTruthy();
});

// Tier 1: the everyday chart acceptance showed an unlabeled polyline. A streamed
// data patch must update its visible point values, category labels and accessible data.
it('labels chart points in place and updates them when the model revises a value', () => {
  const source = line(1, {
    op: 'create',
    id: 'trend',
    kind: 'chart',
    props: {
      label: '收入（万元）',
      variant: 'line',
      data: [
        { label: '1月', value: 12 },
        { label: '2月', value: 18 },
      ],
    },
  });
  const props = { stateKey: 'chart-labels', renderMarkdown: (text: string) => <span>{text}</span> };
  const view = render(<RichAnswer {...props} source={source} complete={false} />);
  expect(screen.getByRole('img').getAttribute('aria-label')).toContain('1月: 12, 2月: 18');
  expect([...view.container.querySelectorAll('svg text')].map((n) => n.textContent)).toContain(
    '12',
  );
  expect(screen.getByText('2月')).toBeTruthy();
  view.rerender(
    <RichAnswer
      {...props}
      source={
        source +
        line(2, {
          op: 'patch',
          id: 'trend',
          props: {
            data: [
              { label: '1月', value: 12 },
              { label: '2月', value: -6 },
            ],
          },
        })
      }
      complete
    />,
  );
  expect(screen.getByRole('img').getAttribute('aria-label')).toContain('2月: -6');
  expect(view.container.querySelectorAll('circle')).toHaveLength(2);
  expect(view.container.querySelector('polyline')?.getAttribute('points')).not.toMatch(
    /NaN|Infinity/,
  );
});

// Tier 1: native icons must retain their text (including an unknown icon name),
// without interpreting a model-supplied name as a resource or action.
it('renders native icon explanations and keeps unknown icon text readable', () => {
  const source =
    line(1, {
      op: 'create',
      id: 'mail',
      kind: 'icon',
      props: { name: 'mail', label: '邮件', text: '收发工作消息' },
    }) +
    line(2, {
      op: 'create',
      id: 'other',
      kind: 'icon',
      props: { name: 'https://invalid.example/icon.svg', label: '未知入口', text: '保留说明' },
    });
  const view = render(
    <RichAnswer
      stateKey="icons"
      source={source}
      complete
      renderMarkdown={(text) => <span>{text}</span>}
    />,
  );
  expect(screen.getByText('邮件')).toBeTruthy();
  expect(screen.getByText('收发工作消息')).toBeTruthy();
  expect(screen.getByText('保留说明')).toBeTruthy();
  expect(view.container.querySelectorAll('svg')).toHaveLength(2);
  expect(view.container.querySelector('img, button, a')).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
});
