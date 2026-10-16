import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import { SortableList } from '../../src/renderer/components/sidebar/SortableList';
import { CardMasonry } from '../../src/renderer/features/cc-agent/sidebar/CardMasonry';
import { defaultDark } from '../../src/renderer/themes/builtin/default-dark';
import { defaultLight } from '../../src/renderer/themes/builtin/default-light';
import '../../src/renderer/themes/colors';
import { themeService } from '../../src/renderer/themes/theme-service';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') ?? 'text';
const columns = Number(params.get('columns') ?? 1);
themeService.applyTheme(params.get('theme') === 'dark' ? defaultDark : defaultLight);

function App() {
  const [items, setItems] = useState(['project-a', 'task', 'project-b', 'project-c']);
  const [writes, setWrites] = useState(0);
  const [clicks, setClicks] = useState(0);
  const renderItem = (id: string) =>
    id === 'task' ? (
      <div
        data-testid={id}
        data-split-group-drag-source="true"
        draggable
        className="flex h-10 items-center rounded-lg bg-[var(--surface-elevated)] px-3"
      >
        Pinned task
      </div>
    ) : (
      <div data-testid={id} className="rounded-lg bg-[var(--surface-elevated)]">
        <div
          data-project-header="true"
          role="button"
          tabIndex={0}
          className="flex h-10 select-none items-center gap-2 px-3"
        >
          <span data-testid={`${id}-title`} className="min-w-0 flex-1">
            {id}
          </span>
          <button type="button" onClick={() => setClicks((n) => n + 1)}>
            Action
          </button>
        </div>
        <div data-no-drag className="p-2">
          <input aria-label={`${id} rename`} defaultValue="Rename" className="w-full" />
          <div data-testid={`${id}-child`}>Child task</div>
        </div>
      </div>
    );
  const props = {
    items,
    getId: (id: string) => id,
    renderItem,
    forceFallback: params.get('fallback') === 'true',
    reducedMotion: true,
    onReorder: (ids: string[]) => {
      setItems(ids);
      setWrites((n) => n + 1);
    },
  };
  return (
    <>
      <div
        data-testid="pins"
        style={{ width: mode === 'card' ? [220, 340, 460][columns - 1] : 460 }}
      >
        {mode === 'card' ? (
          <CardMasonry {...props} />
        ) : (
          <SortableList {...props} className="flex flex-col gap-1" />
        )}
      </div>
      <output data-testid="order">{JSON.stringify(items)}</output>
      <output data-testid="writes">{writes}</output>
      <output data-testid="clicks">{clicks}</output>
      <div
        data-testid="outside"
        className="fixed right-4 top-4 h-40 w-40 border border-[var(--border-default)]"
        onDragOver={(event) => event.preventDefault()}
      >
        Outside the pinned list
      </div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
