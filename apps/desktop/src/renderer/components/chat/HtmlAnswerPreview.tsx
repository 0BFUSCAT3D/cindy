import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HTML_ANSWER_MAX_HEIGHT, htmlAnswerHeight, prepareHtmlAnswer } from '@cindy/maker-shared/html-answer';
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
  const [height, setHeight] = useState(1);
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
    let disposed = false;
    let viewId: string | undefined;
    const release = () => {
      if (viewId) void window.electronAPI.htmlAnswerPreview({ viewId }).catch(() => {});
    };
    setUrl(undefined);
    setFailed(false);
    setHeight(1);
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
  }, [documentHtml, attempt]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const next = htmlAnswerHeight(event.data);
      if (next !== null) setHeight(next);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  return (
    <div className="min-w-0" data-html-answer="true">
      {failed ? (
        <Button variant="secondary" tone="quiet" size="sm"
          onClick={() => setAttempt(value => value + 1)}>
          {t('commonUi.retry')}
        </Button>
      ) : url ? (
        <iframe
          ref={frame}
          src={url}
          title="HTML"
          sandbox="allow-scripts"
          scrolling={height >= HTML_ANSWER_MAX_HEIGHT ? 'auto' : 'no'}
          className="block w-full border-0"
          style={{ height }}
        />
      ) : null}
    </div>
  );
}
