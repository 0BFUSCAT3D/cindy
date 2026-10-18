/** Presentation only: no instructions are added to the model's context. */
export function htmlAnswerDocument(text: string): string | null {
  let source = text.trim();
  const fence = source.match(/^(`{3,}|~{3,})html\s*\n([\s\S]*?)\n\1\s*$/i);
  if (fence) source = fence[2].trim();
  // A complete document is an answer artifact. Ordinary HTML examples stay code.
  return /^(?:<!doctype\s+html\b[^>]*>\s*)?<html(?:\s|>)/i.test(source) &&
    /<\/html>\s*$/i.test(source)
    ? source
    : null;
}

// Bound pathological documents without making ordinary long answers a nested scroller.
export const HTML_ANSWER_MAX_HEIGHT = 100_000;

export function htmlAnswerHeight(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const data = value as { type?: unknown; height?: unknown };
  return data.type === "cindy-html-answer-size" &&
    typeof data.height === "number" &&
    Number.isFinite(data.height) &&
    data.height > 0
    ? Math.max(1, Math.min(HTML_ANSWER_MAX_HEIGHT, Math.ceil(data.height)))
    : null;
}

/** Host theme and a size-only notification. No tool or application bridge. */
export function prepareHtmlAnswer(
  html: string,
  theme: { background: string; foreground: string; dark: boolean },
): string {
  const encodedTheme = JSON.stringify(theme).replace(/</g, "\\u003c");
  return `<meta name="viewport" content="width=device-width, initial-scale=1"><style>
  :root { color-scheme: ${theme.dark ? "dark" : "light"}; }
  html, body { min-height: 0 !important; }
  body { margin: 0; font: 16px/1.6 system-ui, sans-serif; background: var(--cindy-answer-bg); color: var(--cindy-answer-fg); overflow-wrap: anywhere; }
  img,video,svg,canvas { max-width: 100%; } * { box-sizing: border-box; }
  </style><script>(()=>{
    const theme=${encodedTheme};
    document.documentElement.style.setProperty('--cindy-answer-bg',theme.background);
    document.documentElement.style.setProperty('--cindy-answer-fg',theme.foreground);
    addEventListener('DOMContentLoaded',()=>{
      let previous=0;
      const measure=()=>{
        const body=document.body,style=getComputedStyle(body);
        const height=Math.max(1,Math.ceil(Math.max(body.scrollHeight,body.getBoundingClientRect().height)+(parseFloat(style.marginTop)||0)+(parseFloat(style.marginBottom)||0)));
        if(height===previous)return;previous=height;
        const data={type:'cindy-html-answer-size',height};
        if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(data));
        else parent.postMessage(data,'*');
      };
      new ResizeObserver(measure).observe(document.body);measure();
    },{once:true});
  })();</script>${html}`;
}
