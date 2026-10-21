// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// 把 style 展平进 data-style,断言每个 Text 实际叠了哪些样式。
vi.mock('react-native', async () => {
  const React = await import('react');
  const flat = (style: unknown): Record<string, unknown> =>
    Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
  const host = (tag: string) => ({ children, style, horizontal, onLayout, testID }: any) => {
    React.useEffect(() => { onLayout?.({ nativeEvent: { layout: { width: 280 } } }); }, [onLayout]);
    return React.createElement(tag, { 'data-style': JSON.stringify(flat(style)),
      'data-horizontal': horizontal, 'data-testid': testID }, children);
  };
  return {
    View: host('div'),
    ScrollView: host('section'),
    Text: host('span'),
    useWindowDimensions: () => ({ width: 360, height: 800, fontScale: 1, scale: 3 }),
    StyleSheet: { create: (s: any) => s, flatten: (s: any) => s, hairlineWidth: 1 },
    Platform: { OS: 'ios', select: (s: any) => s.ios ?? s.default },
  };
});
vi.mock('@/components/AppText', async () => ({ Text: (await import('react-native')).Text }));
vi.mock('@/theme', () => ({
  fontWeight: { regular: '400', medium: '500', semibold: '600', bold: '700' },
  monoFont: 'Menlo',
  useThemedStyles: (make: (colors: any) => any) => make(new Proxy({}, { get: () => '#000' })),
}));

import { BotGroupMarkdownText } from '@/session/BotGroupMessageText';

let root: Root;
let node: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  node = document.createElement('div');
  document.body.append(node);
  root = createRoot(node);
});

// #6713: real group body previously flattened tables into one Text. DOM hosts do not
// measure RN layout; verify the rendered row/cell geometry here, then test native scrolling in Simulator.
it('keeps table columns aligned across short, long and empty cells, with horizontal overflow', async () => {
  await act(async () => root.render(createElement(BotGroupMarkdownText, {
    content: '| 项目 | 说明 | 状态 |\n| --- | --- | --- |\n| A | **很长的说明内容需要在所属单元格内换行，不能串到下一列** | 完成 |\n| B | | 进行中 |',
  })));
  const scroll = node.querySelector('section[data-horizontal="true"]');
  expect(scroll).not.toBeNull();
  const rows = [...scroll!.firstElementChild!.children];
  expect(rows).toHaveLength(3);
  const widths = rows.map(row => [...row.children].map(cell => JSON.parse(cell.getAttribute('data-style')!).width));
  expect(widths[0]).toHaveLength(3);
  expect(widths[1]).toEqual(widths[0]);
  expect(widths[2]).toEqual(widths[0]);
  expect(widths[0].reduce((a, b) => a + b, 0)).toBeGreaterThan(280);
  expect([...rows[2].children].map(cell => cell.textContent)).toEqual(['B', '', '进行中']);
  expect(styleOf('很长的说明内容需要在所属单元格内换行，不能串到下一列').fontWeight).toBe('600');
  expect(node.textContent).not.toContain(' | ');
});

it('expands a short table to the measured message width without changing code blocks', async () => {
  await act(async () => root.render(createElement(BotGroupMarkdownText, {
    content: '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n~~~text\na | b\n~~~',
  })));
  const row = node.querySelector('section')!.firstElementChild!.firstElementChild!;
  const widths = [...row.children].map(cell => JSON.parse(cell.getAttribute('data-style')!).width);
  expect(widths.reduce((a, b) => a + b, 0)).toBe(280);
  expect(styleOf('a | b').fontFamily).toBe('Menlo');
});
afterEach(() => {
  act(() => root.unmount());
  node.remove();
});

const styleOf = (text: string): Record<string, unknown> => {
  // 取最内层的匹配(强调外层 Text 与内层代码 Text 文本相同)。
  const span = [...node.querySelectorAll('span')].filter((el) => el.textContent === text).at(-1);
  expect(span, `未找到文本 ${text}`).toBeDefined();
  return JSON.parse(span!.getAttribute('data-style')!);
};

it('群聊不打开链接:强调里的链接只保留强调样式,不加下划线', async () => {
  await act(async () => root.render(createElement(BotGroupMarkdownText, {
    content: '**https://a.example/x** ~~https://b.example/y~~ **`a.ts`**',
  })));
  expect(styleOf('https://a.example/x')).toMatchObject({ fontWeight: '600' });
  expect(styleOf('https://a.example/x').textDecorationLine).toBeUndefined();
  expect(styleOf('https://b.example/y').textDecorationLine).toBe('line-through');
  // 强调里的行内代码照常套代码样式。
  expect(styleOf('a.ts')).toMatchObject({ fontFamily: 'Menlo' });
});
