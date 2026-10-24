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
    return [...rule.source].length <= 2 ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])` : source;
  });
  const automatic = [
    String.raw`[A-Za-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`,
    String.raw`(?:https?://[^\s<>"']+/(?:provider-share|shared-task|chat)/join|cindy(?:cn|dev)?://(?:provider-share|shared-task)/join|cindy(?:cn|dev)?://shared-session)[#?][^\s<>"']+`,
    String.raw`(?:/Users/|/home/|[A-Za-z]:[\\/]Users[\\/])[^\\/\s<>"']+`,
  ];
  // Generated examples are semantic placeholders, even when a one-letter name
  // occurs inside them (e.g. real nickname A -> 用户 A). Protect the complete
  // placeholder on subsequent observer scans; never exempt the raw name itself.
  const protectedValues = [...new Set(rules.filter(r => r.category !== 'custom'
    && r.replacement && !rules.some(other => other.source === r.replacement)).map(r => r.replacement))];
  const protectedPatterns = [...protectedValues.sort((a, b) => b.length - a.length).map(escape),
    String.raw`contact-\d+@example\.com`, String.raw`https://example\.com/share/demo`, '<示例目录>'];
  const regex = new RegExp([...protectedPatterns, ...patterns, ...automatic].map(p => `(${p})`).join('|'), 'gu');
  const dynamic = new Map();
  const transform = (value, audit = false) => {
    let count = 0;
    const result = value.replace(regex, (...args) => {
      const found = args.slice(1, protectedPatterns.length + rules.length + automatic.length + 1).findIndex(group => group !== undefined);
      const source = args[0];
      if (found < protectedPatterns.length) return source;
      const index = found - protectedPatterns.length;
      if (index < rules.length) { count++; return audit ? source : rules[index].replacement; }
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
    const [devices, owned, received, shared, hosted] = await Promise.all([
      api.deviceLink.listDevices(),
      api.providerShare.command({ action: 'owned', range: 'all' }),
      api.providerShare.command({ action: 'received' }),
      api.sharedTask.account({ action: 'list' }),
      api.sharedTask.account({ action: 'owned' }),
    ]);
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
  const visit = (root, apply) => {
    let residual = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node = root;
    while (node) {
      if (node.nodeType === Node.TEXT_NODE && !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(node.parentElement?.tagName)) {
        const avatarInitial = initials.has(node.nodeValue) && node.parentElement?.classList.contains('rounded-full');
        if (apply) change(node, '#text', avatarInitial ? '●' : replacer.replace(node.nodeValue));
        else residual += avatarInitial ? 1 : replacer.count(node.nodeValue);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
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
    try { visit(document.documentElement, true); } catch { fault = true; }
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
    delete window[key];
    return { failures };
  };
  // If the CLI is killed or CDP disconnects, do not leave a permanently altered UI.
  const unsubscribers = [];
  const invalidate = () => { fault = true; };
  const api = window.electronAPI;
  for (const subscribe of [api?.onAuthStateChange, api?.deviceLink?.onPresenceChanged,
    api?.providerShare?.onRequested, api?.providerShare?.onOwnedChanged,
    api?.providerShare?.onReceivedChanged, api?.providerShare?.onReshareRequested]) {
    if (subscribe) unsubscribers.push(subscribe(invalidate));
  }
  const known = new Set([...entries.map(e => e.source), ...avatars].filter(Boolean));
  const renderedChanged = () => {
    const current = readRendered?.();
    if (!current) return false;
    const values = [...current.devices, ...current.ids, ...current.people.flatMap(p =>
      [p.displayName, p.email, p.avatarUrl, p.orgName, p.orgLogoUrl, p.note])];
    return values.some(value => value && !known.has(value));
  };
  const watchdog = setTimeout(restore, 60000);
  window[key] = {
    audit() { scan(); return { residual: visit(document.documentElement, false), fault: fault || renderedChanged() }; },
    restore,
  };
  scan();
  frame = requestAnimationFrame(tick);
  return { rules: replacer.rules.length, avatars: avatarSet.size };
}
