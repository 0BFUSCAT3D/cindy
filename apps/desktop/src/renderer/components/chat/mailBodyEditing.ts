import { mailTextParagraphs, safeMailDocument, type MailInlineImage } from '@cindy/maker-shared/mail-text-edit';

/** Capture authored paint before the preview theme changes it. Only sanitized
 * markup is saved; local image URLs and editor attributes never leave the UI. */
export function mailBodySerializer(doc: Document, source: string, images: () => readonly MailInlineImage[] = () => []) {
  const styles = new WeakMap<Element, string | null>();
  for (const el of [doc.body, ...doc.body.querySelectorAll('*')]) {
    styles.set(el, el.getAttribute('style'));
  }
  const head = safeMailDocument(source).match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? '';
  return () => {
    const inert = doc.createElement('template').content.ownerDocument;
    const body = inert.importNode(doc.body, true) as HTMLElement;
    const live = [doc.body, ...doc.body.querySelectorAll('*')];
    const copies = [body, ...body.querySelectorAll('*')];
    copies.forEach((copy, i) => {
      if (styles.has(live[i])) {
        const style = styles.get(live[i]);
        if (style == null) copy.removeAttribute('style');
        else copy.setAttribute('style', style);
      }
      // Restore only an attachment supplied by the Host, never a reference
      // taken straight from mutable editor DOM. Unresolved original cid: URLs
      // already survive cloning; local preview URLs are stripped below.
      const image = images().find(image => image.cid === copy.getAttribute('data-cindy-mail-cid'));
      if (image) copy.setAttribute('src', `cid:${image.cid}`);
      copy.removeAttribute('contenteditable');
      copy.removeAttribute('spellcheck');
    });
    for (const span of body.querySelectorAll('[data-cindy-mail-run]')) {
      const walker = inert.createTreeWalker(span, 4 /* SHOW_TEXT */);
      const texts: Text[] = [];
      while (walker.nextNode()) texts.push(walker.currentNode as Text);
      for (const node of texts) {
        if (!node.data.includes('\n')) continue;
        const parts = node.data.split('\n');
        node.replaceWith(...parts.flatMap((text, i) => i
          ? [inert.createElement('br'), inert.createTextNode(text)]
          : [inert.createTextNode(text)]));
      }
      span.replaceWith(...span.childNodes);
    }
    // The preview sanitizer adds this marker to CID images; it is not mail data.
    const html = safeMailDocument(`<html><head>${head}</head>${body.outerHTML}</html>`)
      .replace(/ data-cindy-mail-cid="[^"]*"/g, '');
    const text = mailTextParagraphs(html).map(p => p.text).join('\n\n');
    return html.length <= 64000 && text.length <= 16000 && !text.includes('\0') ? { html, text } : null;
  };
}
