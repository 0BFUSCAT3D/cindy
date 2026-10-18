import {
  Fragment,
  useMemo,
  useRef,
  useState,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
  type CSSProperties,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  RichAnswerStream,
  RichInteractionMemory,
  richAction,
  richChart,
  richResolvedValues,
  richCalculationUnavailable,
  richLabel,
  richMarkdown,
  richNumber,
  richOptions,
  richRange,
  richString,
  type RichNode,
  type RichValue,
} from '@cindy/maker-shared/rich-answer';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import './rich-answer.css';

const memory = new RichInteractionMemory({
  async read() {
    return localStorage.getItem('cindy.richAnswer.viewState.v1');
  },
  writeSync(value) { localStorage.setItem('cindy.richAnswer.viewState.v1', value); },
  async write(value) {
    localStorage.setItem('cindy.richAnswer.viewState.v1', value);
  },
});
/** Component identities and user input survive content patches; no generated HTML executes. */
export function RichAnswer({
  source,
  complete,
  stateKey,
  renderMarkdown,
  renderMedia,
}: {
  source: string;
  complete: boolean;
  stateKey: string;
  renderMedia?: (node: RichNode) => ReactNode;
  renderMarkdown: (source: string, id: string) => ReactNode;
}) {
  const { user } = useAuth();
  return (
    <RichAnswerDocument
      key={`${user?.id ?? 'signed-out'}:${stateKey}`}
      source={source}
      complete={complete}
      stateKey={`${user?.id ?? 'signed-out'}:${stateKey}`}
      renderMarkdown={renderMarkdown}
      renderMedia={renderMedia}
    />
  );
}
function RichAnswerDocument({
  source,
  complete,
  stateKey,
  renderMarkdown,
  renderMedia,
}: {
  source: string;
  complete: boolean;
  stateKey: string;
  renderMedia?: (node: RichNode) => ReactNode;
  renderMarkdown: (source: string, id: string) => ReactNode;
}) {
  const { t } = useTranslation();
  const parser = useRef(new RichAnswerStream());
  const doc = useMemo(() => parser.current.update(source, complete), [source, complete]);
  const edited = useSyncExternalStore(memory.subscribe, () => memory.get(stateKey));
  useEffect(() => {
    void memory.load();
    const save = () => memory.flushSync();
    window.addEventListener('pagehide', save);
    return () => {
      window.removeEventListener('pagehide', save);
      void memory.flush();
    };
  }, []);
  const values = richResolvedValues(doc, edited);
  const change = (key: string, v: RichValue) => memory.set(stateKey, { [key]: v });
  const apply = (node: RichNode) => memory.set(stateKey, richAction(node, values));
  const render = (id: string): ReactNode => {
    const node = doc.nodes.get(id);
    if (!node) return null;
    if (richCalculationUnavailable(node, values)) return <p className="rich-answer-caption" role="status">{complete ? t('richAnswer.calculationUnavailable') : '…'}</p>;
    const bind = richString(node, 'bind', id),
      label = richString(node, 'label');
    const children = node.children.map((child) => <Fragment key={child}>{render(child)}</Fragment>);
    if ((['image', 'video', 'audio'].includes(node.kind)) && renderMedia)
      return (
        <div className="rich-answer-content">
          {renderMedia(node)}
          {richString(node, 'caption') && (
            <div className="rich-answer-caption">{richString(node, 'caption')}</div>
          )}
        </div>
      );
    const md = richMarkdown(node);
    if (md !== null)
      return (
        <div data-rich-node={id} className="rich-answer-content">
          {renderMarkdown(md, id)}
          {richString(node, 'caption') && (
            <div className="rich-answer-caption">{richString(node, 'caption')}</div>
          )}
        </div>
      );
    switch (node.kind) {
      case 'heading':
        return <h3 className="rich-answer-heading">{richLabel(node, values)}</h3>;
      case 'text':
        return <p className="rich-answer-text">{richLabel(node, values)}</p>;
      case 'divider':
        return <hr className="rich-answer-divider" />;
      case 'stack':
      case 'row':
      case 'grid':
      case 'group':
        return (
          <div
            data-rich-node={id}
            className={`rich-answer-layout rich-answer-${node.kind}${richString(node, 'layout') === 'aside' ? ' rich-answer-aside' : ''}`}
            style={
              {
                '--rich-columns': Math.round(
                  Math.max(1, Math.min(3, richNumber(node, 'columns', 2))),
                ),
              } as CSSProperties
            }
          >
            {children}
          </div>
        );
      case 'stat':
        return (
          <div className="rich-answer-stat">
            <div className="rich-answer-caption">{label}</div>
            <output>{richLabel(node, values)}</output>
          </div>
        );
      case 'range': {
        const range = richRange(node, values[bind]);
        return (
          <div className="rich-answer-control">
            <div className="rich-answer-control-label">
              <span>{label}</span>
              <output>
                {range.value}
                {richString(node, 'suffix')}
              </output>
            </div>
            <Slider
              aria-label={label}
              min={range.min}
              max={range.max}
              step={range.step}
              value={[range.value]}
              onValueChange={(v) => change(bind, v[0])}
            />
          </div>
        );
      }
      case 'input':
        return (
          <label className="rich-answer-control">
            {label}
            <Input
              aria-label={label}
              value={String(values[bind] ?? '')}
              placeholder={richString(node, 'placeholder')}
              maxLength={4096}
              onChange={(value) => change(bind, value)}
            />
          </label>
        );
      case 'check':
        return (
          <label className="rich-answer-check">
            <input
              type="checkbox"
              checked={Boolean(values[bind])}
              onChange={(event) => change(bind, event.target.checked)}
            />
            <span>{label || richString(node, 'text')}</span>
          </label>
        );
      case 'select':
        return (
          <label className="rich-answer-control">
            {label}
            <select
              className="rich-answer-select"
              value={String(values[bind] ?? '')}
              onChange={(event) => change(bind, event.target.value)}
            >
              <option value="" disabled>
                {richString(node, 'placeholder', label)}
              </option>
              {richOptions(node).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        );
      case 'button':
        return (
          <Button variant="secondary" tone="quiet" onClick={() => apply(node)}>
            {label || richString(node, 'text')}
          </Button>
        );
      case 'form':
        return (
          <form
            className="rich-answer-layout rich-answer-stack"
            onSubmit={(event) => {
              event.preventDefault();
              apply(node);
            }}
          >
            {children}
            {label && (
              <Button type="submit" variant="secondary">
                {label}
              </Button>
            )}
          </form>
        );
      case 'details':
        return (
          <details
            open={Boolean(values[bind])}
            onToggle={(event) => {
              if (Boolean(values[bind]) !== event.currentTarget.open)
                change(bind, event.currentTarget.open);
            }}
          >
            <summary>{label}</summary>
            <div className="rich-answer-layout rich-answer-stack">{children}</div>
          </details>
        );
      case 'tabs': {
        const selected = node.children.includes(String(values[bind]))
          ? String(values[bind])
          : node.children[0];
        return (
          <div>
            <div className="rich-answer-tabs" role="tablist" aria-label={label}>
              {node.children.map((child) => (
                <Button
                  key={child}
                  role="tab"
                  aria-selected={selected === child}
                  variant="secondary"
                  tone="quiet"
                  onClick={() => change(bind, child)}
                >
                  {richString(doc.nodes.get(child)!, 'label', child)}
                </Button>
              ))}
            </div>
            {node.children.map((child) => (
              <div key={child} role="tabpanel" hidden={selected !== child}>
                {render(child)}
              </div>
            ))}
          </div>
        );
      }
      case 'chart': {
        const data = richChart(node, values),
          min = Math.min(0, ...data.map((item) => item.value)),
          max = Math.max(0, ...data.map((item) => item.value)),
          span = max - min || 1;
        return (
          <figure className="rich-answer-chart">
            <figcaption>{label}</figcaption>
            {richString(node, 'variant') === 'line' ? (
              <svg role="img" aria-label={label} viewBox="0 0 480 180">
                <polyline
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  points={data
                    .map(
                      (item, i) =>
                        `${10 + (i / Math.max(1, data.length - 1)) * 460},${170 - ((item.value - min) / span) * 160}`,
                    )
                    .join(' ')}
                />
              </svg>
            ) : null}
            <dl>
              {data.map((item, i) => (
                <div key={i}>
                  <div className="rich-answer-control-label">
                    <dt>{item.label}</dt>
                    <dd>{item.value}</dd>
                  </div>
                  {richString(node, 'variant') !== 'line' && (
                    <div className="rich-answer-track">
                      <div style={{ marginLeft: `${((Math.min(0, item.value) - min) / span) * 100}%`, width: `${(Math.abs(item.value) / span) * 100}%` }} />
                    </div>
                  )}
                </div>
              ))}
            </dl>
          </figure>
        );
      }
      default:
        return null;
    }
  };
  return (
    <div className="rich-answer" data-rich-answer>
      {doc.roots.map((id) => (
        <Fragment key={id}>{render(id)}</Fragment>
      ))}
      {doc.issues > 0 && (
        <p className="rich-answer-caption" role="status">
          {t('richAnswer.incomplete')}
        </p>
      )}
    </div>
  );
}
