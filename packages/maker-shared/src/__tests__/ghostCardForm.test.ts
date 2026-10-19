import { describe, expect, it } from "vitest";
import { applyMailInlineEdits, mailInlineRuns, mailTextParagraphs, safeMailDocument } from '../mailTextEdit';
import {
  parseGhostCardForm,
  parseGhostCardFormValues,
  readGhostCardForm,
  omitGhostCardFormPreview,
  trackGhostCardFormDelivery,
  pendingGhostCardFormDelivery,
  ghostCardRecipients,
  fitGhostCardRecipients,
  mailCardStatus,
  parseMailCard,
  insertMailImage,
  mailPreviewImages,
  visibleMailAttachments,
} from "../ghostCardForm";

describe("declarative card forms", () => {
  // Shared presentation contract: inline images disappear only from the list,
  // never from the outgoing MIME data. Text, comments and CID prefixes do not count.
  it('lists ordinary attachments and restores images when their last HTML reference is removed', () => {
    const files = [
      { key: 'body', filename: 'body.png', contentId: '<body>', mimeType: 'image/png' },
      { key: 'quote', filename: 'quote.jpg', contentId: 'quote', mimeType: 'image/jpeg' },
      { key: 'unused', filename: 'unused.png', contentId: 'unused', mimeType: 'image/png' },
      { key: 'pdf', filename: 'notes.pdf', mimeType: 'application/pdf' },
    ];
    const values = { attachmentItems: JSON.stringify(files), bodyHtml: '<img src="cid:body"><!-- <img src="cid:unused"> --><p>cid:unused</p><img src="cid:unused-extra">', quoteHtml: "<IMG SRC='cid:quote'>" };
    expect(visibleMailAttachments(values).map(f => f.key)).toEqual(['unused', 'pdf']);
    expect(JSON.parse(values.attachmentItems)).toEqual(files);
    expect(visibleMailAttachments({ ...values, bodyHtml: '' }).map(f => f.key)).toEqual(['body', 'unused', 'pdf']);
    expect(visibleMailAttachments({ ...values, bodyHtml: '', quoteHtml: '' })).toEqual(files);
  });
  it('inserts existing image bytes with an unused CID and keeps preview addresses out of the authored HTML', () => {
    const url = `cindy-media://blobs/${'a'.repeat(64)}.png`;
    const values = { bodyHtml: '<html><head><style>img{width:200px}</style></head><body><p>Hi</p></body></html>', attachmentItems: JSON.stringify([
      { key: 'first', filename: 'first.png', mimeType: 'image/png', contentId: 'image-1@cindy.local' },
      { key: 'next', filename: '<next>.png', mimeType: 'image/png', previewUrl: url },
      { key: 'pdf', filename: 'notes.pdf', mimeType: 'application/pdf' },
    ]) };
    const next = insertMailImage(values, 'attachmentItems', 'next');
    expect(next.bodyHtml).toContain('src="cid:image-2@cindy.local" alt="&lt;next&gt;.png"');
    expect(next.bodyHtml).toContain('<style>img{width:200px}</style>');
    expect(next.bodyHtml).not.toContain('cindy-media:');
    expect(mailPreviewImages(next)).toEqual([{ cid: 'image-2@cindy.local', url }]);
    expect(visibleMailAttachments(next).map(f => f.key)).toEqual(['first', 'pdf']);
    expect(insertMailImage(next, 'attachmentItems', 'next')).toBe(next);
    expect(insertMailImage(values, 'attachmentItems', 'pdf')).toBe(values);
  });
  // User correction: simple typing must preserve HTML, not flatten it. Unit
  // tests cover the shared production text patcher; previous coverage was preview-only.
  it('edits paragraphs and line breaks while preserving CSS, inline formatting, links and CID images', () => {
    const html = '<!doctype html><html><head><style>p{color:red}</style></head><body><p>Hello <b>Cherry</b> &amp; Dash</p><p><a href="https://example.test">Link</a><br>Next</p><img src="cid:card"></body></html>';
    expect(mailTextParagraphs(html).map(p => p.text)).toEqual(['Hello Cherry & Dash', 'Link\nNext']);
    expect(applyMailInlineEdits(html, {})!.html).toBe(html);
    expect(mailInlineRuns(html).map(r => r.text)).toEqual(['Hello ', 'Cherry', ' & Dash', 'Link', '\n', 'Next']);
    const updated = applyMailInlineEdits(html, { 0: 'Hello Dear ', 5: 'New\nNext' })!;
    expect(updated.html).toContain('<p>Hello Dear <b>Cherry</b> &amp; Dash</p>');
    expect(updated.html).toContain('<a href="https://example.test">Link</a><br>New<br>Next');
    expect(updated.html).toContain('<style>p{color:red}</style>');
    expect(updated.html).toContain('src="cid:card"');
    expect(updated.text).toBe('Hello Dear Cherry & Dash\n\nLink\nNew\nNext');
    expect(applyMailInlineEdits(html, { 1: '' })!.html).toContain('<p>Hello <b></b> &amp; Dash</p>');
    expect(applyMailInlineEdits('<p></p>', { 0: 'New greeting' })!.html).toBe('<p>New greeting</p>');
    const invalid: Record<string, string>[] = [{ '-1': 'x' }, { 999: 'x' }, { 0: 'x'.repeat(16001) }, { 0: '\0' }];
    for (const edits of invalid) expect(applyMailInlineEdits(html, edits)).toBeNull();
  });
  it('treats typed markup as text and allows adding words to an image-only draft', () => {
    const html = '<html><head><title>Not body text</title></head><body><img src="cid:card"></body></html>';
    expect(mailTextParagraphs(html).map(p => p.text)).toEqual(['']);
    const updated = applyMailInlineEdits(html, { 0: 'Hi <script>alert(1)</script>\n你好' })!;
    expect(updated.html).toContain('<img src="cid:card">Hi &lt;script&gt;alert(1)&lt;/script&gt;<br>你好</body>');
    expect(updated.text).toBe('Hi <script>alert(1)</script>\n你好');
  });
  it('creates editable markers only after stripping authored controls and executable content', () => {
    const safe = safeMailDocument('<p contenteditable="true" data-cindy-mail-run="99" onclick="evil()">Hello</p><script>evil()</script><iframe src="x"></iframe><img src="cid:card">', true);
    expect(safe).toContain('<span data-cindy-mail-run="0">Hello</span>');
    expect(safe).not.toMatch(/evil|contenteditable|iframe|run="99"/);
    expect(safeMailDocument('<p></p>', true)).toContain('<p><span data-cindy-mail-run="0"></span></p>');
  });
  it('round-trips a pending send and derives the displayed time without granting send permission', () => {
    const mail = parseMailCard({ accountId: 'a', draftId: 'd', key: '12345678-1234-1234-1234-123456789abc', from: 'self@example.test',
      fields: ['to', 'cc', 'bcc', 'subject', 'body'].map(name => ({ name, label: name, value: '' })),
      attachments: [], state: 'sending', status: 'Waiting', sendLabel: 'Send', fromLabel: 'From',
      pendingSend: { deadline: 11000, label: '{seconds} 秒后发送', cancelLabel: '撤销', sendNowLabel: '立即发送' } });
    expect(mail).not.toBeNull();
    expect(mailCardStatus(mail!, 1000)).toBe('10 秒后发送');
    expect(mailCardStatus(mail!, 10001)).toBe('1 秒后发送');
    expect(mailCardStatus(mail!, 12000)).toBe('0 秒后发送');
    expect(parseMailCard({ ...mail, state: 'sent' })).toBeNull();
    expect(parseMailCard({ ...mail, pendingSend: { ...mail!.pendingSend, deadline: 'soon' } })).toBeNull();
  });
  // Width-based overflow must not omit a recipient or split a quoted display
  // name into multiple people. Pure unit coverage shared by both renderers.
  it("packs measured names only when needed and preserves quoted addresses", () => {
    const addresses =
      '"Smith, Jane" <jane@example.test>, 李明 <li@example.test>';
    expect(ghostCardRecipients(addresses)).toEqual([
      { address: '"Smith, Jane" <jane@example.test>', label: "Smith, Jane" },
      { address: "李明 <li@example.test>", label: "李明" },
    ]);
    const groups = [
      { label: 30, chips: [50, 100, 50], more: [12, 20, 20, 20] },
      { label: 20, chips: [40], more: [12, 20] },
    ];
    expect(fitGhostCardRecipients(500, groups)).toEqual([3, 1]);
    expect(fitGhostCardRecipients(190, groups)).toEqual([1, 1]);
    // If only one name fits, keep the primary recipient rather than a Cc name.
    expect(fitGhostCardRecipients(160, groups)).toEqual([1, 0]);
    expect(fitGhostCardRecipients(100, groups)).toEqual([0, 0]);
    const field = {
      name: "to",
      label: "To",
      value: addresses,
      kind: "recipients",
    };
    expect(parseGhostCardForm([field])?.[0]).toEqual(field);
    expect(
      parseGhostCardForm([{ ...field, kind: "future" }])?.[0].kind,
    ).toBeUndefined();
  });
  it("holds chat behind edits in flight and fails closed until a new delivery succeeds", async () => {
    let resolve!: (ok: boolean) => void;
    trackGhostCardFormDelivery(
      "task",
      "card",
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = pendingGhostCardFormDelivery("task")!;
    expect(pendingGhostCardFormDelivery("other")).toBeUndefined();
    resolve(false);
    expect(await pending).toBe(false);
    expect(await pendingGhostCardFormDelivery("task")).toBe(false);
    trackGhostCardFormDelivery("task", "card", Promise.resolve(true));
    expect(await pendingGhostCardFormDelivery("task")).toBe(true);
    expect(pendingGhostCardFormDelivery("task")).toBeUndefined();
  });
  it("round-trips text, quotes, newlines and markup as inert data", () => {
    const fields = [
      {
        name: "body",
        label: "Message",
        value: '<script> & "\n正文',
        multiline: true,
      },
    ];
    const encoded = JSON.stringify(fields)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    expect(
      readGhostCardForm(`<div data-ghost-form="${encoded}">Preview</div>`),
    ).toEqual(fields);
    expect(
      omitGhostCardFormPreview(
        `<div data-ghost-form="${encoded}"><div>Nested preview</div></div><p>Sender</p>`,
      ),
    ).toBe("<p>Sender</p>");
    expect(parseGhostCardFormValues({ body: "  exact\n" })).toEqual({
      body: "  exact\n",
    });
  });
  it("rejects duplicates, prototype keys, oversized and unsupported fields", () => {
    const field = { name: "body", label: "Message", value: "text" };
    for (const fields of [
      [field, field],
      [{ ...field, name: "__proto__" }],
      [{ ...field, value: "x".repeat(16001) }],
      [{ ...field, multiline: "yes" }],
    ])
      expect(parseGhostCardForm(fields)).toBeNull();
    for (const values of [
      [],
      {},
      { body: 1 },
      { constructor: "x" },
      { body: "x".repeat(16001) },
    ])
      expect(parseGhostCardFormValues(values)).toBeNull();
    expect(readGhostCardForm('<div data-ghost-form="[]"></div>')).toBeNull();
  });
});
