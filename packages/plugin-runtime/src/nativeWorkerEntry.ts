import { Socket } from 'node:net';
import { createRequire } from 'node:module';
import { createControlPort } from './controlPort.js';
import { startNodePluginWorker } from './nodeWorker.js';

// Deliberately not child_process IPC: plugins never receive process.send,
// process.channel, or a public process 'message' event with authorization data.
const channel = new Socket({ fd: 3, readable: true, writable: true });
channel.once('close', () => process.exit(0));
const port = createControlPort(channel, () => process.exit(1));
startNodePluginWorker(port, createRequire(__filename));
