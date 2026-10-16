// @vitest-environment jsdom
/**
 * ChatInput × 标注烧录中止:已有任务的发送会请求 annotationBurnFailure: 'abort';
 * 发送被中止(onSend 返回 false,makerChatStore 烧录失败时即如此)后,点击时的正文、
 * 附件与矢量笔迹原样回到输入框,用户可直接重试。脚手架与 chatInputModelLoading
 * 相同:外部宿主服务全部惰性,编辑器、输入框状态与发送派发真实运行。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComponentProps, ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import type { ProviderView } from '@cindy/model-providers';
import { sshNativeCodexProvider, sshModel } from '@/features/cc-agent/__tests__/sshModelFixtures';
import type { AttachedFile } from '@/lib/fileTypes';
import { ChatInput } from '../ChatInput';
import { clearDraft, saveDraft } from '@/lib/composerDraftStore';
import type { AtMentionPanel } from '../AtMentionPanel';
import type { scanAtResources } from '@/lib/atResourceService';
import type { ExtraDirsButton } from '../ExtraDirsButton';

const h = vi.hoisted(() => ({ t: (key: string) => key, confirm: vi.fn(), editor: null as Editor | null, listening: false, stop: vi.fn().mockResolvedValue(undefined),
  setModel: vi.fn(), selectModel: undefined as undefined | ((id: string) => Promise<void | boolean>), remoteProviders: [] as ProviderView[],
  remoteStatus: 'ready' as 'ready' | 'loading' | 'error',
  scan: vi.fn<typeof scanAtResources>(),
  atPanel: null as ComponentProps<typeof AtMentionPanel> | null,
  documentChanged: vi.fn(),
}));

vi.mock('react-i18next', async (original) => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: h.t }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: h.confirm }) }));
vi.mock('@/components/sidebar/SortableList', () => ({
  SortableList: ({
    items,
    renderItem,
    role,
    ariaLabel,
    className,
  }: {
    items: readonly unknown[];
    renderItem: (item: unknown, index: number) => ReactNode;
    role?: string;
    ariaLabel?: string;
    className?: string;
  }) => (
    <div role={role} aria-label={ariaLabel} className={className}>
      {items.map((item, index) => (
        <div key={index}>{renderItem(item, index)}</div>
      ))}
    </div>
  ),
}));
vi.mock('../ModelSelector', async (original) => ({ ...await original<typeof import('../ModelSelector')>(), ModelSelector: ({ modelId, onModelChange }: { modelId: string; onModelChange: typeof h.selectModel }) => {
  h.selectModel = onModelChange;
  return <span data-testid="model-selector">{modelId}</span>;
} }));
vi.mock('@/hooks/useSshCodexProviders', () => ({ useSshCodexProviders: () => ({ providers: h.remoteProviders, status: h.remoteStatus, refresh: () => {} }) }));
vi.mock('../ExtraDirsButton', () => ({ ExtraDirsButton: ({ open, onOpenChange, panel }: ComponentProps<typeof ExtraDirsButton>) => <><button aria-label="test-suggestions" onClick={() => onOpenChange?.(!open)} />{open && panel}</> }));
vi.mock('../PermissionSelector', () => ({ PermissionSelector: () => <span data-testid="permission-selector" /> }));
vi.mock('../NewGoalDialog', () => ({ NewGoalDialog: () => null }));
vi.mock('../FolderPickerPopover', () => ({ FolderPickerPopover: () => null, addRecentFolder: vi.fn() }));
vi.mock('../AtMentionPanel', () => ({ AtMentionPanel: (props: ComponentProps<typeof AtMentionPanel>) => { h.atPanel = props; return null; } }));
vi.mock('@/lib/atResourceService', async (original) => ({ ...await original<typeof import('@/lib/atResourceService')>(), scanAtResources: h.scan }));
vi.mock('../SlashCommandPalette', () => ({ SlashCommandPalette: () => null }));
vi.mock('@/voice-input/VoiceInputPointerHintLayer', () => ({ VoiceInputPointerHintLayer: ({ children }: { children: import('react').ReactNode }) => <>{children}</> }));
vi.mock('@/voice-input/VoiceInputStatusNotice', () => ({ VoiceInputStatusNotice: () => null }));
vi.mock('@/voice-input/useVoiceInput', () => ({ useVoiceInput: (editor: Editor | null) => {
  // Attach before ChatInput's first hydration effect so an empty-document
  // replacement on initial mount cannot hide from the regression assertion.
  if (editor && editor !== h.editor) editor.on('transaction', ({ transaction }) => { if (transaction.docChanged) h.documentChanged(); });
  h.editor = editor;
  return { state: h.listening ? 'listening' : 'idle', isListening: h.listening, isBusy: h.listening, draftText: '', start: vi.fn(), stop: h.stop, cancel: vi.fn() };
} }));
vi.mock('@/hooks/useProviders', () => ({ useProviders: () => ({ providers: [], loading: false }) }));
vi.mock('@/hooks/useDeviceProviders', () => ({ useDeviceProviders: () => ({ providers: [], loading: false, unsupported: false }) }));
vi.mock('@/hooks/useConnectedSource', () => ({ useConnectedSource: () => ({ hasConnectedSource: true, loading: false }) }));
vi.mock('@/hooks/useAvailableAgents', () => ({ useAvailableAgents: () => ({ agents: [], loading: false }) }));
vi.mock('@/hooks/useAgentCapabilities', async (original) => ({ ...await original<typeof import('@/hooks/useAgentCapabilities')>(), useAgentCapabilities: () => ({ capabilities: null, loading: false }) }));

const noOp = () => {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api: any = new Proxy({}, { get: (_obj, key) => {
  if (key === 'setModel') return h.setModel;
  if (key === 'listSync') return () => ({ ghosts: [] });
  if (key === 'getDataSnapshot') return () => { throw new Error('test bridge unavailable'); };
  if (key === 'setGlobalShortcut') return () => Promise.resolve({ ok: true });
  if (key === 'platform') return 'darwin';
  if (key === 'then') return undefined;
  if (String(key).startsWith('on')) return () => noOp;
  return new Proxy(() => Promise.resolve(undefined), { get: (_fn, nested) => api[nested] });
} });

const strokes = [{ points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }] }];
const annotatedImage: AttachedFile = {
  id: 'tray-annotated',
  name: 'shot.png',
  path: '/Users/sam/shot.png',
  ext: '.png',
  size: 10,
  category: 'image',
  mimeType: 'image/png',
  url: 'cindy-media://blobs/tray.png',
  annotationStrokes: strokes,
};

beforeEach(() => {
  h.editor = null;
  h.documentChanged.mockClear();
  h.listening = false;
  h.atPanel = null;
  h.scan.mockReset().mockResolvedValue({ success: true, items: [], truncated: false });
  window.electronAPI = api;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); clearDraft('composer-regression'); h.remoteProviders = []; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function renderComposer(extra: Partial<ComponentProps<typeof ChatInput>> = {}) {
  const attachmentState: ComponentProps<typeof ChatInput>['attachmentState'] = {
    attachments: [], hasAttachments: false, addFiles: vi.fn(), addClipboardImage: vi.fn(),
    rejections: [], dismissRejection: noOp, clearRejections: noOp, addFolderPath: noOp,
    pendingFoldersVersion: 0, consumePendingFolders: () => [], addFileMention: noOp,
    pendingFileMentionsVersion: 0, consumePendingFileMentions: () => [],
    removeFile: noOp, updateFile: noOp, discardFiles: noOp, clearFiles: noOp, restoreFiles: files => [...files],
  };
  const props = { draftKey: 'composer-regression', deviceLinkDeviceId: null,
    attachmentState,
    hideRuntimeControls: true, showFolderPicker: false, disableAutofocus: true,
    onSend: vi.fn().mockResolvedValue(true), ...extra };
  const view = render(<ChatInput {...props} />);
  return { ...view, props };
}

// Replaces the source-only guards with real editor transactions at the two
// external-draft boundaries. Empty paragraph JSON is the minimal #720 input;
// a document replacement would remap the live voice insertion anchor.
it('does not replace the empty editor after an external empty-draft notification', async () => {
  renderComposer();
  await waitFor(() => expect(h.editor).not.toBeNull());
  const changed = vi.fn();
  h.editor!.on('transaction', ({ transaction }) => { if (transaction.docChanged) changed(); });
  await act(async () => saveDraft('composer-regression', {
    text: { type: 'doc', content: [{ type: 'paragraph' }] }, attachments: [],
  }));
  expect(changed).not.toHaveBeenCalled();
  expect(h.editor!.state.selection.from).toBe(1);
});

it('does not rehydrate an empty stored document when voice busy state changes', async () => {
  saveDraft('composer-regression', { text: { type: 'doc', content: [{ type: 'paragraph' }] }, attachments: [] });
  const view = renderComposer();
  await waitFor(() => expect(h.editor).not.toBeNull());
  expect(h.documentChanged).not.toHaveBeenCalled();
  const changed = vi.fn();
  h.editor!.on('transaction', ({ transaction }) => { if (transaction.docChanged) changed(); });
  h.listening = true;
  view.rerender(<ChatInput {...view.props} />);
  h.listening = false;
  view.rerender(<ChatInput {...view.props} />);
  expect(changed).not.toHaveBeenCalled();
  expect(h.editor!.state.selection.from).toBe(1);
});

// A prompt preview hides the old draft. Its first key must only dismiss the
// preview; dispatch tests without a preview cannot catch this accidental send.
it('dismisses a preview on Enter without sending or changing the hidden draft', async () => {
  const view = renderComposer();
  await waitFor(() => expect(h.editor).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>unsent draft</p>'); });
  view.rerender(<ChatInput {...view.props} previewPrompt="preview suggestion" />);
  expect(screen.getByText('preview suggestion')).toBeTruthy();
  fireEvent.keyDown(h.editor!.view.dom, { key: 'Enter', code: 'Enter' });
  expect(view.props.onSend).not.toHaveBeenCalled();
  expect(h.editor!.getText()).toBe('unsent draft');
  expect(screen.queryByText('preview suggestion')).toBeNull();
});

it('does not let a pending local resource scan repopulate an SSH composer', async () => {
  let finish!: (value: Awaited<ReturnType<typeof scanAtResources>>) => void;
  h.scan.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const view = renderComposer({ initialWorkingDir: '/workspace' });
  await waitFor(() => expect(h.editor).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'test-suggestions' }));
  await waitFor(() => expect(h.scan).toHaveBeenCalled());
  h.atPanel = null;
  view.rerender(<ChatInput {...view.props} remoteHostId="ssh-host" />);
  // Synthetic + remains mounted for SSH, unlike the typed-@ panel. Require
  // fresh ready props so a stale captured value cannot make this test pass.
  const currentPanelState = () => h.atPanel?.state;
  await waitFor(() => expect(currentPanelState()).toEqual({ kind: 'ready', items: [], truncated: false }));
  await act(async () => finish({ success: true, items: [{ type: 'file', relPath: 'stale.txt', name: 'stale.txt' }], truncated: false }));
  expect(currentPanelState()).toEqual({ kind: 'ready', items: [], truncated: false });
});

it('keeps a remote draft with no directory local-scan-free, but searches nonempty queries remotely', async () => {
  renderComposer({ deviceLinkDeviceId: 'remote-device' });
  await waitFor(() => expect(h.editor).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>@</p>'); h.editor!.commands.setTextSelection(2); });
  await waitFor(() => expect(h.atPanel).not.toBeNull());
  expect(h.scan).not.toHaveBeenCalled();
  await act(async () => { h.editor!.commands.insertContent('needle'); });
  await waitFor(() => expect(h.scan).toHaveBeenCalled());
  expect(h.scan).toHaveBeenLastCalledWith('', expect.any(String), 2000, 'needle', 'remote-device', expect.objectContaining({ includeLocalContext: false, includeTaskHistory: true }));
});

it('restores text, attachments and strokes after an aborted annotated send', async () => {
  h.remoteProviders = [sshNativeCodexProvider([sshModel('remote-only')])];
  const restoreFiles = vi.fn((files: readonly AttachedFile[]) => [...files]);
  const clearFiles = vi.fn();
  const attachmentState: ComponentProps<typeof ChatInput>['attachmentState'] = {
    attachments: [annotatedImage], hasAttachments: true, addFiles: vi.fn(), addClipboardImage: vi.fn(),
    rejections: [], dismissRejection: noOp, clearRejections: noOp, addFolderPath: noOp,
    pendingFoldersVersion: 0, consumePendingFolders: () => [], addFileMention: noOp,
    pendingFileMentionsVersion: 0, consumePendingFileMentions: () => [],
    removeFile: noOp, updateFile: noOp, discardFiles: noOp, clearFiles, restoreFiles,
  };
  // makerChatStore 在烧录失败时返回 false(见 pendingQueueDefer 的中止用例)。
  const onSend = vi.fn().mockResolvedValue(false);
  const view = render(
    <ChatInput sessionId="ssh-annotated" initialWorkingDir="/workspace" runtimeAgentKind="codex"
      vendorKey="codex" deviceLinkDeviceId={null} remoteHostId="builder" attachmentState={attachmentState}
      hideRuntimeControls showFolderPicker={false} disableAutofocus
      initialModel="remote-only" initialProviderId="openai" initialEffort="low" onSend={onSend} />,
  );
  await waitFor(() => expect(view.container.querySelector('[contenteditable]')).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>Look at the circled button</p>'); });

  const send = screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement;
  await act(async () => { fireEvent.click(send); });
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));

  const [, , , , sentFiles, , sendOpts] = onSend.mock.calls[0];
  expect(sendOpts).toEqual(expect.objectContaining({ annotationBurnFailure: 'abort' }));
  expect(sentFiles).toEqual([expect.objectContaining({ id: 'tray-annotated', annotationStrokes: strokes })]);

  // 恢复链路与其它发送失败共用(restoreRemoteOptimisticDraft),正文原样回来、不重复。
  await waitFor(() => expect(h.editor!.getText().trim()).toBe('Look at the circled button'));
  expect(clearFiles).toHaveBeenCalled();
  const restored = restoreFiles.mock.calls.at(-1)?.[0] ?? [];
  expect(restored).toEqual([expect.objectContaining({ id: 'tray-annotated', annotationStrokes: strokes })]);
});
