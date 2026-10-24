// E2E: real Electron + React + CDP, only synthetic identities. Production entry:
// screenshot()/installMask(). Protects PR #7047's redraw/tooltip/restore contract;
// unit mocks cannot expose DOM timing or React value-tracker changes. Minimal
// failures: re-render during masking, property-only input change, failed capture.
// Run explicitly: node scripts/desktop-screenshot/selftest.mjs (not test:unit).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { cdpJson } from './instances.mjs';
import { connectCdp } from './cdp.mjs';
import { collectIdentities, createReplacer, installMask, readRenderedIdentities } from './masking.mjs';
import { parseArgs, screenshot } from '../desktop-screenshot.mjs';

const require = createRequire(import.meta.url);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-screenshot-selftest-'));
let child, client;
const fixtures = `
import React from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {Schema} from ${JSON.stringify(require.resolve('@tiptap/pm/model'))};
import {EditorState} from ${JSON.stringify(require.resolve('@tiptap/pm/state'))};
import {EditorView} from ${JSON.stringify(require.resolve('@tiptap/pm/view'))};
import {history,undoDepth} from ${JSON.stringify(require.resolve('@tiptap/pm/history'))};
import {flushSync} from ${JSON.stringify(require.resolve('react-dom'))};
const root=createRoot(document.getElementById('root'));
window.electronAPI={authListAccounts:async()=>({accounts:[{displayName:'Synthetic Alice',email:'alice@private.test',avatarUrl:'https://example.invalid/avatar.png',isCurrent:true}]}),deviceLink:{listDevices:async()=>({devices:[{name:'Synthetic Laptop'}]})},providerShare:{command:async c=>c.action==='owned'?{shares:[]}:{received:[]}},sharedTask:{account:async()=>[]}};
function SharedPerson(props){return React.createElement('span',{id:'remote-person'},props.displayName)}
function Page({version}){const [tip,setTip]=React.useState(false);return React.createElement('main',{id:'fixture'},
 React.createElement('p',{id:'name',title:'Synthetic Alice', 'aria-label':'alice@PRIVATE.test'},'Hello Synthetic Alice '+version),
 React.createElement('input',{id:'number',type:'number',defaultValue:'500'}),
 React.createElement('input',{id:'input',defaultValue:'alice@PRIVATE.test',placeholder:'Synthetic Alice'}),
 React.createElement('img',{id:'avatar',src:'https://example.invalid/avatar.png',alt:'Synthetic Alice',width:40,height:40}),
 React.createElement('button',{id:'hover',onMouseEnter:()=>setTip(true)},'Hover'),
 tip&&React.createElement('aside',{role:'tooltip'},'Synthetic Laptop / Synthetic Alice'),
 React.createElement(SharedPerson,{displayName:version===3?'New Synthetic Guest':'Remote Synthetic Guest',avatarUrl:null}),
 React.createElement('span',{id:'amount'},'60% / 12.50'),
 React.createElement('span',{id:'link'},'https://relay.example.test/provider-share/join#synthetic-secret'))}
window.renderFixture=(version)=>flushSync(()=>root.render(React.createElement(Page,{version})));
window.renderFixture(1);
const editorHost=document.createElement('div');document.body.append(editorHost);
const schema=new Schema({nodes:{doc:{content:'paragraph+'},paragraph:{content:'text*',toDOM:()=>['p',0]},text:{inline:true}}});
window.editorChanges=0;
window.editor=new EditorView(editorHost,{state:EditorState.create({schema,doc:schema.node('doc',null,[schema.node('paragraph',null,[schema.text('Synthetic Alice')])]),plugins:[history()]}),dispatchTransaction(transaction){window.editorChanges++;this.updateState(this.state.apply(transaction))}});
window.editorState=()=>({text:editor.state.doc.textContent,changes:editorChanges,undo:undoDepth(editor.state)});
window.editorBlurs=0;editor.dom.addEventListener('blur',()=>editorBlurs++);editor.focus();
const previewStyle=document.createElement('style');previewStyle.textContent='.preview-mode .ProseMirror{opacity:0}';document.head.append(previewStyle);

window.electronAPI.providerShare.onReceivedChanged=fn=>{window.refreshReceived=()=>fn([{owner:{displayName:'Synthetic Alice',avatarUrl:'https://example.invalid/avatar.png'}}]);return ()=>{delete window.refreshReceived}};
`;
try {
  await build({ stdin: { contents: fixtures, resolveDir: process.cwd() }, bundle: true, outfile: path.join(dir, 'fixture.js'), logLevel: 'silent' });
  await fs.writeFile(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div><script src="fixture.js"></script>');
  await fs.writeFile(path.join(dir, 'electron.cjs'), `const {app,BrowserWindow}=require('electron'); app.setPath('userData',${JSON.stringify(path.join(dir, 'profile'))}); app.commandLine.appendSwitch('remote-debugging-port','0'); app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:640,height:480,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}}); await w.loadFile(${JSON.stringify(path.join(dir, 'index.html'))}); console.log('FIXTURE_READY');});`);
  child = spawn(require('electron'), [path.join(dir, 'electron.cjs')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  let output = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('selftest startup timeout')), 20000);
    let port;
    const read = bytes => {
      output += bytes.toString();
      const match = output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);
      if (match) port = Number(match[1]);
      if (port && output.includes('FIXTURE_READY')) { clearTimeout(timer); resolve(port); }
    };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.once('error', () => { clearTimeout(timer); reject(new Error('selftest Electron failed to start')); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('selftest Electron exited')); });
  });
  const [target] = await cdpJson(port, 'list');
  client = await connectCdp(target.webSocketDebuggerUrl, port);
  const key = '__selftestMask';
  const local = { home: '/home/synthetic', username: 'synthetic', hostname: 'Synthetic Host' };
  await client.evaluate(`(async()=>{const identities=await (${collectIdentities.toString()})(electronAPI,${JSON.stringify(local)},${readRenderedIdentities.toString()});return (${installMask.toString()})({...identities,keep:[],key:'${key}'},${createReplacer.toString()},${readRenderedIdentities.toString()});})()`);
  const view = () => client.evaluate(`({text:document.getElementById('fixture').textContent,title:document.getElementById('name').title,aria:document.getElementById('name').getAttribute('aria-label'),input:document.getElementById('input').value,src:document.getElementById('avatar').src,amount:document.getElementById('amount').textContent})`);
  let state = await view();
  assert.ok(!state.text.includes('Synthetic Alice'));
  assert.ok(!state.text.includes('Remote Synthetic Guest'));
  assert.equal(state.title, '用户 A');
  assert.equal(state.aria, 'user-1@example.com');
  assert.equal(state.input, 'user-1@example.com');
  assert.ok(state.src.startsWith('data:image/svg+xml'));
  assert.equal(state.amount, '60% / 12.50');
  assert.deepEqual(await client.evaluate('editorState()'), { text: 'Synthetic Alice', changes: 0, undo: 0 });
  assert.equal(await client.evaluate("document.querySelector('.ProseMirror[contenteditable=false]').textContent.includes('Synthetic Alice')"), false);
  assert.deepEqual(await client.evaluate('({focused:document.activeElement===editor.dom,blurs:editorBlurs})'), { focused: true, blurs: 0 });
  await client.evaluate("document.body.classList.add('preview-mode')");
  await client.evaluate(`window.${key}.audit()`);
  assert.equal(await client.evaluate("getComputedStyle(document.querySelector('.ProseMirror[contenteditable=false]')).opacity"), '0');
  await client.evaluate("document.body.classList.remove('preview-mode'); editor.setProps({editable:()=>false})");
  await client.evaluate(`window.${key}.audit()`);
  assert.equal(await client.evaluate("document.querySelectorAll('.ProseMirror[data-cindy-screenshot-copy]').length"), 1);
  assert.equal(await client.evaluate('getComputedStyle(editor.dom).opacity'), '0');
  assert.equal(await client.evaluate("document.querySelector('.ProseMirror[data-cindy-screenshot-copy]').textContent.includes('Synthetic Alice')"), false);
  assert.deepEqual(await client.evaluate('editorState()'), { text: 'Synthetic Alice', changes: 0, undo: 0 });
  await client.evaluate('editor.setProps({editable:()=>true})');
  await client.evaluate("renderFixture(2); document.getElementById('hover').dispatchEvent(new MouseEvent('mouseover',{bubbles:true})); document.getElementById('input').value='new@private.test';");
  // Force the same synchronous final audit the production capture invokes; hidden
  // Electron windows do not promise requestAnimationFrame delivery.
  assert.deepEqual(await client.evaluate(`window.${key}.audit()`), { residual: 0, uncheckedFrames: 0, fault: false });
  state = await view();
  assert.ok(state.text.includes('2') && !state.text.includes('Synthetic'));
  assert.ok(state.input.endsWith('@example.com'));
  assert.ok(await client.evaluate("Boolean(document.querySelector('[role=tooltip]'))"));
  assert.deepEqual(await client.evaluate(`window.${key}.restore()`), { failures: 0 });
  state = await view();
  assert.ok(state.text.includes('Synthetic Alice 2'));
  assert.equal(state.title, 'Synthetic Alice');
  assert.equal(state.input, 'new@private.test');
  assert.equal(state.src, 'https://example.invalid/avatar.png');
  assert.deepEqual(await client.evaluate('editorState()'), { text: 'Synthetic Alice', changes: 0, undo: 0 });
  console.log('PASS 富文本编辑器内容、回调与撤销历史不变');
  console.log('PASS React 重绘、悬停提示、属性、输入值、头像、分享链接、数值保留、最新状态还原');

  const result = await screenshot(client, parseArgs(['--selector', '#fixture', '--padding', '4']), local, { capture: async params => {
    await client.evaluate('refreshReceived()');
    return client.send('Page.captureScreenshot', params);
  } });
  assert.equal(result.data.readUInt32BE(0), 0x89504e47);
  assert.ok((await view()).text.includes('Synthetic Alice'));
  console.log('PASS 真实 CDP PNG 截图、区域裁剪、同内容刷新不中断、成功还原');
  await assert.rejects(screenshot(client, parseArgs([]), local, { capture: async () => { throw new Error('injected capture failure'); } }), /injected capture failure/);
  assert.ok((await view()).text.includes('Synthetic Alice'));
  assert.equal(await client.evaluate("Object.keys(window).filter(k=>k.startsWith('__cindyScreenshot_')).length"), 0);
  console.log('PASS 截图中途失败还原且清除监听');
  await assert.rejects(screenshot(client, parseArgs(['--selector', '#does-not-exist']), local));
  assert.ok((await view()).text.includes('Synthetic Alice'));
  console.log('PASS 无效选择器失败还原');
  await screenshot(client, parseArgs(['--mask', 'Synthetic Alice=示例访客', '--keep', 'Synthetic Laptop']), local, { capture: async params => {
    const current = await view();
    assert.ok(current.text.includes('示例访客') && current.text.includes('Synthetic Laptop'));
    return client.send('Page.captureScreenshot', params);
  } });
  await screenshot(client, parseArgs(['--no-mask']), local, { capture: async params => {
    assert.ok((await view()).text.includes('Synthetic Alice'));
    return client.send('Page.captureScreenshot', params);
  } });
  console.log('PASS --mask、--keep、--no-mask');
  await screenshot(client, parseArgs([]), local, { capture: async params => {
    await assert.rejects(screenshot(client, parseArgs(['--no-mask']), local), /已有截图正在进行/);
    return client.send('Page.captureScreenshot', params);
  } });
  assert.equal(await client.evaluate('Boolean(window.__cindyDesktopScreenshotLock)'), false);
  assert.ok((await view()).text.includes('Synthetic Alice'));
  console.log('PASS 同窗口并发截图拒绝，原截图还原并解锁');
  await client.evaluate("document.getElementById('number').value='700'");
  await screenshot(client, parseArgs(['--mask', '700=示例']), local);
  assert.equal(await client.evaluate("document.getElementById('number').value"), '700');
  console.log('PASS 数字输入框规范化后还原编辑值');
  await assert.rejects(screenshot(client, parseArgs([]), local, { capture: async params => {
    await client.evaluate('renderFixture(3)');
    return client.send('Page.captureScreenshot', params);
  } }), /身份自查未通过/);
  assert.equal(await client.evaluate("Object.keys(window).filter(k=>k.startsWith('__cindyScreenshot_')).length"), 0);
  console.log('PASS 收集后出现新成员时拒绝输出并还原');
  await client.evaluate("const split=document.createElement('p'); split.id='split-secret'; split.innerHTML='Synthetic <strong>Alice</strong>';document.body.append(split)");
  await assert.rejects(screenshot(client, parseArgs([]), local), /身份自查未通过/);
  await client.evaluate("document.getElementById('split-secret').remove()");
  console.log('PASS 跨文字节点残留拒绝输出');
  await client.evaluate(`new Promise(resolve => { const frame=document.createElement('iframe'); frame.id='private-frame'; frame.style.cssText='position:fixed;inset:0;width:200px;height:100px'; frame.srcdoc='<p>Synthetic Alice</p>'; frame.onload=resolve; document.body.append(frame); })`);
  let iframeCaptured = false;
  await assert.rejects(screenshot(client, parseArgs([]), local, { capture: async () => { iframeCaptured = true; } }), /可见嵌入或画布内容/);
  assert.equal(iframeCaptured, false);
  await client.evaluate("document.getElementById('private-frame').style.display='none'");
  await screenshot(client, parseArgs([]), local);
  await client.evaluate("document.getElementById('private-frame').remove()");
  console.log('PASS 可见 iframe 拒绝输出，隐藏 iframe 不阻塞');
  await client.evaluate("const canvas=document.createElement('canvas');canvas.id='private-canvas';canvas.style.cssText='position:fixed;inset:0';canvas.getContext('2d').fillText('Synthetic Alice',10,20);document.body.append(canvas)");
  let canvasCaptured = false;
  await assert.rejects(screenshot(client, parseArgs([]), local, { capture: async () => { canvasCaptured = true; } }), /可见嵌入或画布内容/);
  assert.equal(canvasCaptured, false);
  await client.evaluate("document.getElementById('private-canvas').remove()");
  console.log('PASS 可见 canvas 像素无法核验时拒绝输出并还原');
  await client.evaluate('electronAPI.authListAccounts=async()=>{throw Error("synthetic collection error")};');
  let captured = false;
  await assert.rejects(screenshot(client, parseArgs([]), local, { capture: async () => { captured = true; } }));
  assert.equal(captured, false);
  assert.ok((await view()).text.includes('Synthetic Alice'));
  console.log('PASS 收集失败不截图、不改界面');
} finally {
  client?.close();
  if (child?.pid && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  await fs.rm(dir, { recursive: true, force: true });
}
