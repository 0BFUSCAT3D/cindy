// These functions also execute inside the renderer. Keep their dependencies explicit;
// identity values never need to cross CDP back into command output or a file.
export function createReplacer(entries, keep = []) {
  const retained = new Set(keep.map(value => value.toLocaleLowerCase()));
  const bySource = new Map();
  for (let entry of entries) {
    if (typeof entry.source === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.source)) entry = { ...entry, category: 'email' };
    if (typeof entry.source !== 'string' || !entry.source || retained.has(entry.source.toLocaleLowerCase())) continue;
    const key = entry.category === 'email' ? entry.source.toLocaleLowerCase() : entry.source;
    bySource.set(key, { ...entry, key });
  }
  const rules = [...bySource.values()].sort((a, b) => b.source.length - a.source.length);
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // One pass, longest first: replacement text must never become another rule's input.
  // Short names match whole words (Unicode, including Chinese), not parts of UI labels.
  const patterns = rules.map(rule => {
    const source = rule.category === 'email'
      ? [...rule.source].map(c => /[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : escape(c)).join('')
      : escape(rule.source);
    return source;
  });
  const automatic = [
    String.raw`[A-Za-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`,
    String.raw`(?:https?://[^\s<>"']+/(?:provider-share|shared-task|chat)/join|cindy(?:cn|dev)?://(?:provider-share|shared-task)/join|cindy(?:cn|dev)?://shared-session)[#?][^\s<>"']+`,
    String.raw`(?:/Users/|/home/|[A-Za-z]:[\\/]Users[\\/])[^\\/\s<>"']+`,
  ];
  // Generated examples are semantic placeholders, even when a one-letter name
  // occurs inside them (e.g. real nickname A -> 用户 A). Protect the complete
  // placeholder on subsequent observer scans; never exempt the raw name itself.
  const protectedValues = [...new Set([...rules.map(r => r.replacement), 'https://example.com/share/demo', '<示例目录>']
    .filter(value => value && !rules.some(rule => rule.source === value)))];
  // Longest matching text wins across known identities, examples and automatic
  // candidates. A short example must not hide a longer identity or email address.
  const alternatives = [
    ...protectedValues.map(value => ({ pattern: escape(value), length: value.length, index: -1 })),
    ...patterns.map((pattern, index) => ({ pattern, length: rules[index].source.length, index })),
  ].sort((a, b) => b.length - a.length);
  const compile = items => new RegExp(items.map(({ pattern }) => `(${pattern})`).join('|'), 'gu');
  const regex = compile(alternatives);
  const automaticRegex = new RegExp(automatic.map(pattern => `(${pattern})`).join('|'), 'gu');
  const dynamic = new Map();
  const transform = (value, audit = false) => {
    let count = 0;
    let boundaries;
    const discovered = [...new Map([...value.matchAll(automaticRegex)].map(match => [match[0], { pattern: escape(match[0]),
      length: match[0].length, index: rules.length + match.slice(1).findIndex(group => group !== undefined) }])).values()];
    const candidates = discovered.length ? [...alternatives, ...discovered].sort((a, b) => b.length - a.length) : alternatives;
    if (!candidates.length) return { value, count: 0 };
    const result = value.replace(discovered.length ? compile(candidates) : regex, (...args) => {
      const found = args.slice(1, candidates.length + 1).findIndex(group => group !== undefined);
      const source = args[0];
      const index = candidates[found].index;
      if (index === -1) return source;
      if (index < rules.length) {
        if ([...rules[index].source].length <= 2) {
          // Unicode letter lookarounds incorrectly skip 移除小王. Word segmentation
          // recognizes both Chinese sentence boundaries and embedded Latin names,
          // while keeping A out of API and 小王 out of 小王子.
          boundaries ??= new Set([0, value.length, ...[...new Intl.Segmenter('zh', { granularity: 'word' }).segment(value)].flatMap(s => [s.index, s.index + s.segment.length])]);
          const offset = args.at(-2);
          if (!boundaries.has(offset) || !boundaries.has(offset + source.length)) return source;
        }
        count++; return audit ? source : rules[index].replacement;
      }
      const type = index - rules.length;
      if (retained.has(source.toLocaleLowerCase()) || (type === 0 && /@example\.com$/i.test(source))) return source;
      count++;
      const key = type === 0 ? source.toLocaleLowerCase() : source;
      if (!dynamic.has(key)) dynamic.set(key, type === 0 ? `contact-${dynamic.size + 1}@example.com` : type === 1 ? 'https://example.com/share/demo' : '<示例目录>');
      return audit ? source : dynamic.get(key);
    });
    return { value: result, count };
  };
  return { replace: value => transform(value).value, count: value => transform(value, true).count, rules };
}

// Remote management keeps the selected device in React state, not the URL.
// Read only identity-shaped current props; never serialize hooks or task content.
export function readRenderedIdentities(document = globalThis.document) {
  const people = [], devices = [], ids = [];
  const person = value => people.push({ displayName: value.displayName, email: value.email,
    avatarUrl: value.avatarUrl, orgName: value.orgName, orgLogoUrl: value.orgLogoUrl, note: value.note });
  const seen = new Set();
  const roots = new Set();
  for (const element of document?.querySelectorAll('*') ?? []) {
    const key = Object.keys(element).find(k => k.startsWith('__reactFiber$'));
    let fiber = key && element[key];
    if (!fiber || seen.has(fiber)) continue;
    while (fiber.return) { seen.add(fiber); fiber = fiber.return; }
    roots.add(fiber.stateNode?.current ?? fiber);
  }
  const pending = [...roots];
  seen.clear();
  while (pending.length) {
    const fiber = pending.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    const props = fiber.memoizedProps;
    if (props && typeof props === 'object') {
      // Unsaved profile names and Blob avatar previews have not reached account
      // APIs yet. Read only rendered host props beneath this development component,
      // including its portal, rather than inspecting arbitrary hook state.
      if (fiber.type === 'input' || fiber.type === 'img') {
        let owner = fiber.return;
        while (owner && owner.type?.name !== 'ProfileEditDialog') owner = owner.return;
        if (owner) {
          if (fiber.type === 'input' && props.type === 'text' && typeof props.value === 'string') person({ displayName: props.value.trim() });
          if (fiber.type === 'img') person({ displayName: props.alt, avatarUrl: props.src });
        }
      }
      if ('avatarUrl' in props && typeof props.displayName === 'string') person(props);
      for (const field of ['account', 'member', 'owner']) {
        if (props[field]?.displayName) person(props[field]);
      }
      if (Array.isArray(props.members)) for (const member of props.members) if (member?.displayName) person(member);
      devices.push(props.deviceName, props.selfDeviceName);
      ids.push(props.shareId);
    }
    pending.push(fiber.child, fiber.sibling);
  }
  return { people, devices: devices.filter(Boolean), ids: ids.filter(Boolean) };
}

export async function collectIdentities(api, local, readRendered) {
  const entries = [];
  const avatars = [];
  const counts = new Map();
  const known = new Map();
  const add = (source, category, replacement) => {
    if (typeof source !== 'string' || !source.trim()) return;
    const key = category === 'email' ? source.toLocaleLowerCase() : source;
    if (known.has(key)) return;
    const n = (counts.get(category) ?? 0) + 1;
    counts.set(category, n);
    const labels = { person: `用户 ${String.fromCharCode(64 + n)}`, email: `user-${n}@example.com`, device: `电脑 ${n}`, id: `example-id-${n}`, path: '<本机目录>', username: '示例用户', organization: `组织 ${n}`, link: `https://example.com/share/${n}` };
    known.set(key, true);
    entries.push({ source, category, replacement: replacement ?? labels[category] });
  };
  const person = value => {
    if (!value || typeof value !== 'object') return;
    add(value.displayName ?? value.name, 'person');
    add(value.email, 'email');
    add(value.note, 'person');
    add(value.orgName, 'organization');
    for (const source of [value.avatarUrl, value.orgLogoUrl]) if (typeof source === 'string' && source) avatars.push(source);
  };
  // Read-only renderer contracts; do not call authInitialize (it has startup effects),
  // syncAccounts, create-link, or any setting/mutation API.
  const snapshot = await api.authListAccounts();
  if (!snapshot || !Array.isArray(snapshot.accounts)) throw new Error('accounts');
  snapshot.accounts.forEach(person);
  const loggedIn = snapshot.accounts.some(account => account.isCurrent);
  if (loggedIn) {
    const [devices, owned, receivedSnapshot, shared, hosted] = await Promise.all([
      api.deviceLink.listDevices(),
      api.providerShare.command({ action: 'owned', range: 'all' }),
      api.providerShare.command({ action: 'received-snapshot' }),
      api.sharedTask.account({ action: 'list' }),
      api.sharedTask.account({ action: 'owned' }),
    ]);
    const received = receivedSnapshot?.received;
    if (!Array.isArray(devices?.devices) || !Array.isArray(owned?.shares) || !Array.isArray(received)
      || !Array.isArray(shared) || !Array.isArray(hosted)) throw new Error('identity-shape');
    for (const device of devices.devices) {
      add(device.name, 'device'); add(device.selfName, 'device'); add(device.deviceId, 'id');
    }
    for (const share of owned.shares) {
      add(share.shareId, 'id');
      for (const member of [...share.members, ...share.requests]) {
        person(member);
        add(member.memberId, 'id');
        for (const reshare of member.reshares ?? []) person(reshare);
      }
    }
    for (const share of received) {
      person(share.owner); add(share.deviceName, 'device'); add(share.shareId, 'id'); add(share.hostDeviceId, 'id');
    }
    const ids = [...new Set([...shared, ...hosted].map(item => item.sharedTaskId))];
    for (const sharedTaskId of ids) {
      if (!sharedTaskId) throw new Error('shared-task-id');
      const detail = await api.sharedTask.account({ action: 'get', sharedTaskId });
      if (!Array.isArray(detail?.memberLabels)) throw new Error('shared-task-members');
      detail.memberLabels.forEach(person);
      add(sharedTaskId, 'id');
    }
  }
  const rendered = readRendered?.();
  rendered?.people.forEach(person);
  rendered?.devices.forEach(value => add(value, 'device'));
  rendered?.ids.forEach(value => add(value, 'id'));
  add(local.home, 'path'); add(local.home.replaceAll('\\', '/'), 'path');
  add(local.username, 'username'); add(local.hostname, 'device');
  const current = await api.authListAccounts();
  if (JSON.stringify(current) !== JSON.stringify(snapshot)) throw new Error('account-changed');
  return { entries, avatars, loggedIn };
}

export function installMask({ entries, avatars, keep, key }, makeReplacer, readRendered) {
  if (window[key]) throw new Error('mask-already-installed');
  const replacer = makeReplacer(entries, keep);
  const avatarSet = new Set(avatars.filter(v => !keep.includes(v)));
  const originals = new Map();
  const editors = new Map();
  const editorSelector = ':is([contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], .ProseMirror):not([data-cindy-screenshot-copy])';
  const editorStyle = document.createElement('style');
  editorStyle.textContent = `${editorSelector} { opacity: 0 !important; }`;
  const originalEditor = node => {
    if (!node) return null;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    let editor = element?.closest(editorSelector);
    let outer;
    while (editor && (outer = editor.parentElement?.closest(editorSelector))) editor = outer;
    return editor;
  };
  const syncEditors = () => {
    // Opacity keeps the live editor focused. Temporarily disable our stylesheet
    // during this synchronous measurement (no paint), so real preview/hover styles
    // remain observable instead of copying our own opacity override.
    editorStyle.disabled = true;
    try {
      for (const [source, entry] of editors) if (!source.isConnected || !source.matches(editorSelector)) { entry.clone.remove(); editors.delete(source); }
      for (const source of document.querySelectorAll(editorSelector)) {
        if (originalEditor(source.parentElement)) continue;
        const previous = editors.get(source);
        const content = source.innerHTML;
        const box = [source.offsetLeft, source.offsetTop, source.offsetWidth, source.offsetHeight, source.scrollTop, source.scrollLeft].join(',');
        const computed = getComputedStyle(source);
        const style = [...computed].map(name => `${name}:${computed.getPropertyValue(name)}`).join(';');
        if (previous?.clone.isConnected && previous.clone.parentElement === source.parentElement
          && previous.content === content && previous.box === box && previous.style === style) continue;
        previous?.clone.remove();
        const clone = source.cloneNode(true);
        clone.style.cssText = style;
        clone.setAttribute('contenteditable', 'false');
        clone.setAttribute('data-cindy-screenshot-copy', '');
        clone.removeAttribute('id');
        for (const child of clone.querySelectorAll('[id], [contenteditable], .ProseMirror')) {
          child.removeAttribute('id');
          child.setAttribute('data-cindy-screenshot-copy', '');
          if (child.hasAttribute('contenteditable')) child.setAttribute('contenteditable', 'false');
        }
        Object.assign(clone.style, { position: 'absolute', left: `${source.offsetLeft}px`, top: `${source.offsetTop}px`,
          width: `${source.offsetWidth}px`, height: `${source.offsetHeight}px`, margin: '0',
          boxSizing: 'border-box', pointerEvents: 'none' });
        source.after(clone);
        clone.scrollTop = source.scrollTop;
        clone.scrollLeft = source.scrollLeft;
        editors.set(source, { clone, content, box, style });
      }
      if (editors.size && !editorStyle.isConnected) document.head.append(editorStyle);
    } finally { editorStyle.disabled = false; }
  };
  const renderedText = node => {
    if (originalEditor(node)) return '';
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(node.tagName)) return '';
    if (node.tagName === 'BR') return '\n';
    const content = [...node.childNodes].map(renderedText).join('');
    const display = node.nodeType === Node.ELEMENT_NODE ? getComputedStyle(node).display : 'contents';
    return display === 'contents' || display.startsWith('inline') ? content : `\n${content}\n`;
  };

  const attributes = ['title', 'aria-label', 'aria-description', 'alt', 'placeholder', 'value'];
  const initials = new Set(entries.filter(e => e.category === 'person' && !keep.includes(e.source)).map(e => e.source.charAt(0).toUpperCase()));
  let running = true;
  let frame;
  let fault = false;
  const get = (node, field) => field === '#text' ? node.nodeValue : field === '#value' ? node.value : node.getAttribute(field);
  const put = (node, field, value) => {
    if (field === '#text') node.nodeValue = value;
    else if (field === '#value') {
      // Avoid React's instance-level value tracker; never dispatch input/change events.
      const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value);
    } else if (value === null) node.removeAttribute(field);
    else node.setAttribute(field, value);
  };
  const change = (node, field, value) => {
    const current = get(node, field);
    if (current === value) return;
    const fields = originals.get(node) ?? new Map();
    const old = fields.get(field);
    // A rerender can supply a new original; restore that latest value, not stale UI.
    fields.set(field, { original: old && current === old.masked ? old.original : current, masked: value });
    originals.set(node, fields);
    put(node, field, value);
    // number/date inputs sanitize invalid strings; restore against what the DOM
    // actually accepted, not the requested replacement.
    fields.get(field).masked = get(node, field);
  };
  const isAvatar = value => typeof value === 'string' && [...avatarSet].some(url => value.includes(url));
  const placeholder = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#888"/><circle cx="32" cy="23" r="11" fill="#ddd"/><path d="M10 64v-8a22 22 0 0 1 44 0v8" fill="#ddd"/></svg>');
  let uncheckedFrames = 0;
  const visit = (root, apply) => {
    let residual = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node = root;
    while (node) {
      const editor = originalEditor(node);
      if (editor) { if (!editors.has(editor)) fault = true; node = walker.nextNode(); continue; }
      if (node.nodeType === Node.TEXT_NODE && !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(node.parentElement?.tagName)) {
        const avatarInitial = initials.has(node.nodeValue) && node.parentElement?.classList.contains('rounded-full');
        if (apply) change(node, '#text', avatarInitial ? '●' : replacer.replace(node.nodeValue));
        else residual += avatarInitial ? 1 : replacer.count(node.nodeValue);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (!apply && ['IFRAME', 'FRAME', 'WEBVIEW', 'CANVAS'].includes(node.tagName)) {
          const box = node.getBoundingClientRect();
          if (node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && box.width > 0 && box.height > 0
            && box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight) uncheckedFrames++;
        }
        for (const attr of attributes) {
          const value = node.getAttribute(attr);
          if (value !== null) {
            if (apply) change(node, attr, replacer.replace(value));
            else residual += replacer.count(value);
          }
        }
        if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
          if (apply) change(node, '#value', replacer.replace(node.value));
          else residual += replacer.count(node.value);
        }
        if (node instanceof HTMLImageElement && (isAvatar(node.src) || isAvatar(node.srcset))) {
          if (apply) { change(node, 'src', placeholder); change(node, 'srcset', null); }
          else residual++;
        }
        const style = node.getAttribute('style');
        if (style && isAvatar(style)) {
          if (apply) {
            let masked = style;
            for (const avatar of avatarSet) masked = masked.split(avatar).join(placeholder);
            change(node, 'style', masked);
          } else residual++;
        }
        if (node.shadowRoot) residual += visit(node.shadowRoot, apply);
      }
      node = walker.nextNode();
    }
    return residual;
  };
  const observer = new MutationObserver(() => scan());
  const observe = () => {
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    for (const element of document.querySelectorAll('*')) if (element.shadowRoot) observer.observe(element.shadowRoot, { subtree: true, childList: true, attributes: true, characterData: true });
  };
  const scan = () => {
    if (!running) return;
    observer.disconnect();
    try { syncEditors(); visit(document.documentElement, true); } catch { fault = true; }
    finally { observe(); }
  };
  const tick = () => { scan(); if (running) frame = requestAnimationFrame(tick); };
  const restore = () => {
    running = false;
    observer.disconnect();
    cancelAnimationFrame(frame);
    clearTimeout(watchdog);
    for (const unsubscribe of unsubscribers) unsubscribe?.();
    let failures = 0;
    for (const [node, fields] of originals) for (const [field, value] of fields) {
      try { if (get(node, field) === value.masked) put(node, field, value.original); } catch { failures++; }
    }
    originals.clear();
    for (const { clone } of editors.values()) clone.remove();
    editors.clear();
    editorStyle.remove();
    delete window[key];
    return { failures };
  };
  // If the CLI is killed or CDP disconnects, do not leave a permanently altered UI.
  const unsubscribers = [];
  const invalidate = () => { fault = true; };
  const api = window.electronAPI;
  const known = new Set([...entries.map(e => e.source), ...avatars].filter(Boolean));
  const identityChanged = value => {
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([field, child]) => {
      if (typeof child === 'string' && ['displayName', 'avatarUrl', 'email', 'deviceName', 'avatar', 'name'].includes(field)) return child && !known.has(child);
      return child && typeof child === 'object' && identityChanged(child);
    });
  };
  // A received-share refresh emits even for unchanged identities. Do not turn
  // routine refresh/presence notifications into a permanently failing screenshot.
  for (const subscribe of [api?.onAuthStateChange, api?.deviceLink?.onPresenceChanged,
    api?.providerShare?.onReceivedChanged]) {
    if (subscribe) unsubscribers.push(subscribe(value => { if (identityChanged(value)) invalidate(); }));
  }
  for (const subscribe of [api?.providerShare?.onRequested, api?.providerShare?.onReshareRequested]) {
    if (subscribe) unsubscribers.push(subscribe(invalidate));
  }
  const renderedChanged = () => {
    const current = readRendered?.();
    if (!current) return false;
    const values = [...current.devices, ...current.ids, ...current.people.flatMap(p =>
      [p.displayName, p.email, p.avatarUrl, p.orgName, p.orgLogoUrl, p.note])];
    return values.some(value => value && !known.has(value));
  };
  const watchdog = setTimeout(restore, 60000);
  window[key] = {
    audit() {
      scan();
      // Check continuous inline text too, excluding the untouched editors behind
      // the visual copies. Per-node checks miss Alice <strong>Smith</strong>.
      uncheckedFrames = 0;
      const residual = visit(document.documentElement, false) + replacer.count(renderedText(document.body));
      return { residual, uncheckedFrames, fault: fault || renderedChanged() };
    },
    restore,
  };
  scan();
  frame = requestAnimationFrame(tick);
  return { rules: replacer.rules.length, avatars: avatarSet.size };
}
