import WebSocket from 'ws';

export async function connectCdp(address, port) {
  const url = new URL(address);
  if (url.protocol !== 'ws:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || Number(url.port) !== port) {
    throw new Error('CDP 返回了不属于本机目标端口的地址。');
  }
  const socket = new WebSocket(url, { handshakeTimeout: 3000 });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', () => reject(new Error('CDP 连接失败。'))); });
  let nextId = 0;
  const pending = new Map();
  const fail = () => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('CDP 连接已断开。')); }
    pending.clear();
  };
  socket.on('error', fail);
  socket.on('close', fail);
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    const p = pending.get(message.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(message.id);
    if (message.error) p.reject(new Error('CDP 操作失败（不输出可能含身份信息的远端错误）。'));
    else p.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) return reject(new Error('CDP 连接已断开。'));
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP 操作超时。')); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    send,
    async evaluate(expression) {
      const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw new Error('页面操作失败（不输出可能含身份信息的异常）；未生成截图。');
      return response.result.value;
    },
    close() { socket.close(); socket.terminate(); fail(); },
  };
}
