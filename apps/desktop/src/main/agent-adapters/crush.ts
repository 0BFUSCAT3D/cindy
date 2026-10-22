import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createNativeProcessAdapter,
  NativeAgentError,
  type NativeAdapterOptions,
  type NativeAgentDefinition,
  type NativePreparedSession,
} from './acp.js';
import { boundedText as text, createEventSession, record } from './eventSession.js';

export interface CrushAdapterOptions extends NativeAdapterOptions {
  requestHttp?: typeof httpRequest;
}
const MAX_FRAME = 1024 * 1024;
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

/** Private, owned socket only. Never attach to the user's default Crush server or read config APIs. */
class CrushConnection {
  private requests = new Set<ClientRequest>();
  private ended = false;
  onFailure: (error: NativeAgentError) => void = () => {};
  constructor(
    readonly socketPath: string,
    private options: CrushAdapterOptions,
  ) {}
  close() {
    this.ended = true;
    for (const request of this.requests) request.destroy(new NativeAgentError('closed'));
    this.requests.clear();
  }
  private open(
    method: string,
    path: string,
    body: unknown,
    receive: (
      response: IncomingMessage,
      resolve: (value: unknown) => void,
      reject: (error: Error) => void,
    ) => void,
  ): Promise<unknown> {
    if (this.ended) return Promise.reject(new NativeAgentError('closed'));
    return new Promise((resolve, reject) => {
      let request: ClientRequest;
      const timer = setTimeout(() => {
        const error = new NativeAgentError('timeout');
        reject(error);
        this.onFailure(error);
        request.destroy();
      }, this.options.requestTimeoutMs ?? 30_000);
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      try {
        request = (this.options.requestHttp ?? httpRequest)(
          {
            socketPath: this.socketPath,
            path: '/v1' + path,
            method,
            agent: false,
            headers: { Host: 'api.crush.localhost', 'Content-Type': 'application/json' },
          },
          (response) => {
            response.on('error', () => fail(new NativeAgentError('closed')));
            if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
              response.resume();
              fail(
                new NativeAgentError(response.statusCode === 401 ? 'needs-auth' : 'protocol-error'),
              );
              return;
            }
            receive(
              response,
              (value) => {
                clearTimeout(timer);
                resolve(value);
              },
              fail,
            );
          },
        );
        this.requests.add(request);
        request.once('close', () => this.requests.delete(request));
        request.once('error', fail);
        request.end(body === undefined ? undefined : JSON.stringify(body));
      } catch {
        clearTimeout(timer);
        reject(new NativeAgentError('startup-failed'));
      }
    });
  }
  call(method: string, path: string, body?: unknown): Promise<unknown> {
    return this.open(method, path, body, (response, resolve, reject) => {
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_FRAME) {
          reject(new NativeAgentError('protocol-error'));
          response.destroy();
        }
      });
      response.once('aborted', () => reject(new NativeAgentError('closed')));
      response.once('end', () => {
        try {
          // Workspace creation includes native configuration. Discard it rather than retaining
          // or projecting any provider configuration / environment into Cindy's session state.
          resolve(
            buffer
              ? JSON.parse(buffer, (key, value) =>
                  key === 'config' || key === 'env' ? undefined : value,
                )
              : undefined,
          );
        } catch {
          reject(new NativeAgentError('protocol-error'));
        }
      });
    });
  }
  stream(path: string, onEvent: (event: unknown) => void): Promise<unknown> {
    return this.open('GET', path, undefined, (response, resolve, reject) => {
      if (!String(response.headers['content-type']).startsWith('text/event-stream')) {
        reject(new NativeAgentError('protocol-error'));
        response.destroy();
        return;
      }
      let buffer = '',
        data = '';
      const fail = () => {
        if (!this.ended) this.onFailure(new NativeAgentError('closed'));
        response.destroy();
      };
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) + Buffer.byteLength(data) > MAX_FRAME) return fail();
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          if (line.startsWith('data:')) data += line.slice(5).replace(/^ /, '') + '\n';
          else if (!line && data) {
            try {
              onEvent(JSON.parse(data));
            } catch {
              fail();
              return;
            }
            data = '';
          }
        }
      });
      response.once('close', fail);
      resolve(undefined); // Headers are flushed only after the native subscription is attached.
    });
  }
}

export function createCrushAdapter(
  definition: NativeAgentDefinition,
  options: CrushAdapterOptions = {},
) {
  return createNativeProcessAdapter(
    definition,
    options,
    undefined,
    async (): Promise<NativePreparedSession> => {
      const directory = await mkdtemp(join(tmpdir(), 'cdy-crush-'));
      const dispose = async () => {
        // Windows can release native database handles shortly after process exit.
        // Cleanup is best effort and cannot turn a closed process into an unhandled rejection.
        await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(
          () => {},
        );
      };
      try {
        const windows = (options.platform ?? process.platform) === 'win32';
        if (!windows) await chmod(directory, 0o700);
        const socket = windows ? '\\\\.\\pipe\\cindy-crush-' + randomUUID() : join(directory, 's');
        if (!windows && Buffer.byteLength(socket) >= 104)
          throw new NativeAgentError('startup-failed');
        return {
          args: [
            'server',
            '--host',
            (windows ? 'npipe://' : 'unix://') + socket,
            '--data-dir',
            join(directory, 'server'),
          ],
          dispose,
          async connect(process, request, root) {
            const http = new CrushConnection(socket, options);
            const clientId = randomUUID();
            let base = '',
              sessionId = '',
              runId = '';
            let accepted: Promise<unknown> = Promise.resolve();
            const messages = new Map<string, { text: string; thought: string }>();
            const permissionTools = new Map<string, string>();
            const controller = createEventSession(process, request, {
              async send(message) {
                runId = randomUUID();
                permissionTools.clear();
                accepted = http.call('POST', base + '/agent', {
                  session_id: sessionId,
                  run_id: runId,
                  prompt: message,
                });
                try {
                  await accepted;
                } catch (error) {
                  const failure =
                    error instanceof NativeAgentError
                      ? error
                      : new NativeAgentError('protocol-error');
                  controller.finish(failure);
                  await process.close();
                  throw failure;
                }
              },
              async stop() {
                const target = runId;
                await accepted;
                if (target === runId && controller.running)
                  await http.call('POST', base + '/agent/sessions/' + sessionId + '/cancel');
              },
            });
            const onClose = process.onClose;
            process.onClose = () => {
              http.close();
              onClose();
            };
            http.onFailure = (error) => {
              controller.finish(error);
              void process.close();
            };
            const emitText = (value: string, thought: boolean) => {
              for (let offset = 0; offset < value.length; offset += 16_384)
                controller.emit({
                  type: 'text',
                  data: { text: value.slice(offset, offset + 16_384), thought },
                });
            };
            const snapshot = (id: string, value: string, thought = false) => {
              const previous = messages.get(id) ?? { text: '', thought: '' };
              const key = thought ? 'thought' : 'text';
              if (value.startsWith(previous[key])) {
                emitText(value.slice(previous[key].length), thought);
                previous[key] = value;
              }
              messages.set(id, previous);
            };
            const onEvent = (raw: unknown) => {
              const event = record(raw),
                envelope = record(event?.payload),
                payload = record(envelope?.payload);
              if (!payload || !controller.running) return;
              if (event?.type === 'permission_notification') {
                const key = permissionTools.get(text(payload.tool_call_id));
                if (key) {
                  controller.clearPermission(key);
                  permissionTools.delete(text(payload.tool_call_id));
                }
                return;
              }
              if (payload.session_id !== sessionId) return;
              if (event?.type === 'run_complete' && payload.run_id === runId) {
                if (typeof payload.text === 'string')
                  snapshot(text(payload.message_id), payload.text);
                controller.finish(
                  payload.error
                    ? new NativeAgentError('protocol-error')
                    : payload.cancelled && !controller.cancelled
                      ? new NativeAgentError('unexpected-cancellation')
                      : undefined,
                );
              } else if (
                event?.type === 'message' &&
                envelope?.type !== 'deleted' &&
                Array.isArray(payload.parts)
              ) {
                const id = text(payload.id);
                if (!id) return;
                const parts = payload.parts.map(record);
                if (payload.role === 'assistant') {
                  snapshot(
                    id,
                    parts
                      .filter((p) => p?.type === 'text' && !record(p.data)?.hidden)
                      .map((p) => text(record(p?.data)?.text, MAX_FRAME))
                      .join(''),
                  );
                  snapshot(
                    id,
                    parts
                      .filter((p) => p?.type === 'reasoning')
                      .map((p) => text(record(p?.data)?.thinking, MAX_FRAME))
                      .join(''),
                    true,
                  );
                }
                for (const part of parts) {
                  const data = record(part?.data);
                  if (!data) continue;
                  if (part?.type === 'tool_call' || part?.type === 'tool_result')
                    controller.emit({
                      type: 'tool',
                      data: {
                        id: text(data.id ?? data.tool_call_id, 160),
                        title: text(data.name, 1000),
                        status:
                          part.type === 'tool_result'
                            ? data.is_error
                              ? 'failed'
                              : 'completed'
                            : 'in_progress',
                      },
                    });
                }
              } else if (event?.type === 'permission_request' && typeof payload.id === 'string') {
                const key = text(payload.id),
                  owner = runId;
                permissionTools.set(text(payload.tool_call_id), key);
                controller.permission(
                  key,
                  text(payload.description || payload.tool_name, 1000),
                  [
                    { id: 'allow', label: 'Yes', labelKey: 'yes', kind: 'allow_once' },
                    { id: 'deny', label: 'No', labelKey: 'no', kind: 'reject_once' },
                  ],
                  async (choice) => {
                    if (owner !== runId || process.closed) return;
                    await http.call('POST', base + '/permissions/grant', {
                      permission: payload,
                      action: choice === 'allow' ? 'allow' : 'deny',
                    });
                  },
                );
              } else if (event?.type === 'question_batch_request') {
                // The current host form has no native batch/free-text response contract.
                // Reject visibly instead of leaving an invisible question pending or inventing an answer.
                controller.finish(new NativeAgentError('protocol-error'));
                void process.close();
              }
            };
            const deadline = Date.now() + (options.requestTimeoutMs ?? 30_000);
            while (true) {
              if (process.closed) throw new NativeAgentError('closed');
              try {
                await http.call('GET', '/health');
                break;
              } catch (error) {
                if (process.closed) throw new NativeAgentError('closed');
                if (
                  !['ENOENT', 'ECONNREFUSED'].includes(
                    String((error as NodeJS.ErrnoException).code),
                  )
                )
                  throw error instanceof NativeAgentError
                    ? error
                    : new NativeAgentError('startup-failed');
                if (Date.now() >= deadline) throw new NativeAgentError('timeout');
                await new Promise<void>((resolve) => setTimeout(resolve, 25));
              }
            }
            const workspace = record(
              await http.call('POST', '/workspaces', {
                path: root,
                data_dir: join(directory, 'workspace'),
                client_id: clientId,
                yolo: false,
              }),
            );
            if (!uuid(workspace?.id)) throw new NativeAgentError('protocol-error');
            base = '/workspaces/' + workspace.id;
            const nativeSession = record(
              await http.call('POST', base + '/sessions', { title: 'Cindy' }),
            );
            if (!uuid(nativeSession?.id)) throw new NativeAgentError('protocol-error');
            sessionId = nativeSession.id;
            await http.stream(base + '/events?client_id=' + clientId, onEvent);
            await http.call('POST', base + '/current-session?client_id=' + clientId, {
              session_id: sessionId,
            });
            await http.call('POST', base + '/agent/init', { interactive: true });
            if (process.closed) throw new NativeAgentError('closed');
            return controller.session;
          },
        };
      } catch (error) {
        await dispose();
        throw error;
      }
    },
  );
}
