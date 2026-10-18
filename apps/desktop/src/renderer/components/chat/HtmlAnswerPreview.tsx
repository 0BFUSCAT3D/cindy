import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Code2, Eye } from 'lucide-react';
import { htmlAnswerHeight, prepareHtmlAnswer } from '@cindy/maker-shared/html-answer';
import { Button } from '@/components/ui/button';

function hostTheme() {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  return {
    background: style.getPropertyValue('--surface').trim(),
    foreground: style.getPropertyValue('--text-primary').trim(),
    dark: root.classList.contains('dark'),
  };
}

export function HtmlAnswerPreview({ html }: { html: string }) {
  const { t } = useTranslation();
  const frame = useRef<HTMLIFrameElement>(null);
  const [theme, setTheme] = useState(hostTheme);
  const [source, setSource] = useState(false);
  const [height, setHeight] = useState(320);
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const documentHtml = useMemo(() => prepareHtmlAnswer(html, theme), [html, theme]);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const next = hostTheme();
      setTheme((current) =>
        current.background === next.background &&
        current.foreground === next.foreground &&
        current.dark === next.dark
          ? current
          : next,
      );
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (source) return;
    let disposed = false;
    let viewId: string | undefined;
    const release = () => {
      if (viewId) void window.electronAPI.htmlAnswerPreview({ viewId }).catch(() => {});
    };
    setUrl(undefined);
    setFailed(false);
    setHeight(320);
    void window.electronAPI
      .htmlAnswerPreview({ html: documentHtml })
      .then((view) => {
        if (!view) throw new Error('No preview');
        viewId = view.viewId;
        if (disposed) release();
        else setUrl(view.url);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      release();
    };
  }, [documentHtml, source, attempt]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const next = htmlAnswerHeight(event.data);
      if (next !== null) setHeight(next);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  const showSource = source || failed;
  return (
    <div className="my-3 min-w-0" data-html-answer="true">
      <div className="flex justify-end pb-1">
        <Button
          variant="secondary"
          tone="quiet"
          size="sm"
          compact
          title={t(showSource ? 'chat.htmlAnswer.preview' : 'chat.htmlAnswer.source')}
          aria-label={t(showSource ? 'chat.htmlAnswer.preview' : 'chat.htmlAnswer.source')}
          onClick={() => {
            if (failed) setAttempt((value) => value + 1);
            setFailed(false);
            setSource(!showSource);
          }}
        >
          {showSource ? <Eye size={14} /> : <Code2 size={14} />}
        </Button>
      </div>
      {showSource ? (
        <pre className="overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--msg-tool-card-bg)] p-3">
          <code>{html}</code>
        </pre>
      ) : url ? (
        <iframe
          ref={frame}
          src={url}
          title="HTML"
          sandbox="allow-scripts"
          className="block w-full border-0"
          style={{ height }}
        />
      ) : null}
    </div>
  );
}
