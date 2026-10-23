/**
 * Production entries: encrypted store and authenticated local service transport.
 * Rule: credentials-and-local-storage + the terminal host's single-writer contract.
 * Coverage gap: neither exists on the Desktop transport. Minimal failures: wrong
 * passphrase, a second host, or an unauthenticated pipe client. Tier: integration
 * because the test uses a private temporary directory and actual local sockets.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { once } from 'node:events';
import { TerminalSecretStore } from './secrets.js';
import { TerminalTransportServer, connectTerminal } from './transport.js';
import { socketPath, privateDirectory } from './platform.js';

describe('terminal private host', () => {
  let directory: string;
  beforeAll(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(),'cindy-terminal-host-')); });
  afterAll(async () => { await fs.rm(directory,{recursive:true,force:true}); });

  it('persists encrypted credentials and rejects the wrong passphrase', async () => {
    const dir=path.join(directory,'passphrase');
    const store=new TerminalSecretStore(dir);await store.open();
    await store.initialize('passphrase','test-only-passphrase');
    await store.set('provider','invalid-test-key');
    expect((await fs.readFile(path.join(dir,'secrets.enc'),'utf8')).includes('invalid-test-key')).toBe(false);
    store.lock();await expect(store.get('provider')).rejects.toThrow('VAULT_LOCKED');
    const restored=new TerminalSecretStore(dir);await restored.open();
    await expect(restored.unlock('wrong-test-passphrase')).rejects.toThrow('VAULT_UNLOCK_FAILED');
    await restored.unlock('test-only-passphrase');
    expect(await restored.get('provider')).toBe('invalid-test-key');
    await restored.delete('provider');expect(await restored.get('provider')).toBeNull();
    restored.lock();
  });

  it('automatically unlocks only an explicitly selected machine-key store', async () => {
    const dir=path.join(directory,'machine');
    const store=new TerminalSecretStore(dir);await store.open();
    expect(store.status().initialized).toBe(false);
    await store.initialize('machine');await Promise.all([store.set('one','invalid-one'),store.set('two','invalid-two')]);
    store.lock();const next=new TerminalSecretStore(dir);await next.open();
    expect(await next.get('one')).toBe('invalid-one');expect(await next.get('two')).toBe('invalid-two');
    next.lock();
  });

  it('authenticates calls, fans out events, retains the owner and redacts errors', async () => {
    const dir=path.join(directory,'transport');let calls=0;
    const server=new TerminalTransportServer(dir,async channel => {
      calls++;
      if(channel==='test:failure') throw new Error('invalid-test-key in provider error');
      return { channel };
    });
    await server.listen();
    const client=await connectTerminal(dir);
    const second=await connectTerminal(dir);
    try {
      expect(await client.invoke('test:status')).toEqual({channel:'test:status'});
      const pushed=new Promise(resolve=>second.subscribe((channel,args)=>resolve({channel,args})));
      client.close();server.publish('test:changed',[42]);
      expect(await pushed).toEqual({channel:'test:changed',args:[42]});
      await expect(second.invoke('test:failure')).rejects.toThrow('OPERATION_FAILED');
      const duplicate=new TerminalTransportServer(dir,async()=>null);
      await expect(duplicate.listen()).rejects.toThrow('SERVICE_ALREADY_RUNNING');
      await duplicate.close();
      expect(await second.invoke('test:owner')).toEqual({channel:'test:owner'});
      const unauthenticated=net.createConnection(socketPath(dir));
      await once(unauthenticated,'connect');
      const closed=once(unauthenticated,'close');
      unauthenticated.write(JSON.stringify({type:'invoke',id:'attack',channel:'test:status',args:[]})+'\n');
      await closed;
      expect(calls).toBe(3);
    } finally { client.close();second.close();await server.close(); }
    expect(await fs.stat(path.join(dir,'service.json')).catch(()=>null)).toBeNull();
    if(process.platform!=='win32') await fs.rm(path.dirname(socketPath(dir)),{recursive:true,force:true});
  });

  it('serializes simultaneous stale-owner takeovers without unlinking the winner socket', async () => {
    const dir = path.join(directory, 'concurrent-takeover');
    await privateDirectory(dir);
    await fs.writeFile(path.join(dir, 'service.json'), JSON.stringify({ version: 1, pid: 2147483647, socket: socketPath(dir), key: '0'.repeat(64), instance: 'dead-owner' }), { mode: 0o600 });
    const first = new TerminalTransportServer(dir, async () => 'first');
    const second = new TerminalTransportServer(dir, async () => 'second');
    const results = await Promise.allSettled([first.listen(), second.listen()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results[0]!.status === 'fulfilled' ? first : second;
    const loser = winner === first ? second : first;
    try {
      await loser.close();
      const client = await connectTerminal(dir);
      try { expect(await client.invoke('test:owner')).toBe(winner === first ? 'first' : 'second'); }
      finally { client.close(); }
    } finally { await first.close(); await second.close(); }
    if (process.platform !== 'win32') await fs.rm(path.dirname(socketPath(dir)), { recursive: true, force: true });
  });
});
