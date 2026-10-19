import type { PluginTaskRoute } from './pluginTasks.js';
import type { PluginMessageAttachment } from './pluginAttachments.js';

export type PluginTargetKind = 'project' | 'task' | 'bot';
export type PluginTargetDelivery = 'queue' | 'steer';
export interface PluginTargetView {
  bindingId: string;
  kind: PluginTargetKind;
  label: string;
}
/** Only sent to Cindy's trusted desktop renderer, never to a plugin. */
export interface PluginTargetCandidate {
  id: string;
  label: string;
  detail: string;
}
export interface PluginTargetPickerPush {
  requestId: string;
  pluginName: string;
  kind: PluginTargetKind;
  persistent: boolean;
  candidates: PluginTargetCandidate[];
}
export type PluginTargetRequest =
  | { kind: 'pick'; requestKey: string; targetKind: PluginTargetKind; persistent?: boolean }
  | { kind: 'get'; bindingId: string }
  | {
      kind: 'send';
      requestKey: string;
      bindingId: string;
      text: string;
      attachments?: PluginMessageAttachment[];
      title?: string;
      route?: PluginTaskRoute;
      delivery?: PluginTargetDelivery;
    }
  | { kind: 'cancel'; requestKey: string };
