/* global document, NodeFilter, MutationObserver */
// 通过 CDP 执行本文件，再保存 restore = __cindyScreenshotMask({ 原文: '示例' })。
// 截完（或失败）调用 restore()；输入值／编辑区不改，远程 img 模糊。
// 不覆盖 canvas、嵌入内容、窗口标题栏和系统弹窗；发出前人工检查。
globalThis.__cindyScreenshotMask = (pairs) => {
  const entries = Object.entries(pairs).filter(([key]) => key).sort((a, b) => b[0].length - a[0].length);
  const escaped = entries.map(([key]) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = escaped.length ? new RegExp(escaped.join('|'), 'gu') : /(?!)/g;
  const replacements = new Map(entries), saved = new Map();
  const attrs = ['title', 'aria-label', 'alt', 'placeholder'];
  const skip = 'script,style,[contenteditable],input:focus,textarea:focus';
  const read = (node, key) => key === '#text' ? node.nodeValue : node.getAttribute(key);
  const write = (node, key, value) => key === '#text' ? node.nodeValue = value : node.setAttribute(key, value);
  const replace = (node, key) => {
    const before = read(node, key);
    if (before === null || saved.get(node)?.get(key)?.[1] === before) return;
    const after = before.replace(pattern, (match) => replacements.get(match));
    if (after === before) return;
    if (!saved.has(node)) saved.set(node, new Map());
    saved.get(node).set(key, [before, after]);
    write(node, key, after);
  };
  const blur = document.createElement('style');
  blur.textContent = 'img[src^="https://"],img[src^="http://"] { filter: blur(12px) !important; }';
  document.head.append(blur);
  const scan = () => {
    observer.disconnect(); // 不观察自己的改动，避免循环。
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode()); )
      if (!node.parentElement?.closest(skip + ',textarea')) replace(node, '#text');
    for (const el of document.body.querySelectorAll('*'))
      if (!el.closest(skip)) for (const key of attrs) replace(el, key);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  };
  const observer = new MutationObserver(scan);
  scan();
  return () => {
    observer.disconnect(); blur.remove();
    for (const [node, fields] of saved) for (const [key, [before, after]] of fields)
      if (read(node, key) === after) write(node, key, before);
    saved.clear();
  };
};
