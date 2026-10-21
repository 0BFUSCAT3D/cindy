import { isQwenHttpModel } from './speechProtocols.js';
import type { SpeechProtocol } from './voiceConversation.js';

// Model-specific reference lists, not a provider capability declaration. Compatible
// endpoints may expose a different set; manual IDs and a real preview remain available.
// https://developers.openai.com/api/docs/guides/text-to-speech#voice-options
const STANDARD = ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];
const EXPRESSIVE = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
];

export function referenceSpeechVoices(
  modelId: string,
  protocol?: SpeechProtocol,
): readonly string[] {
  // Model Studio reference examples, not account voice discovery. Custom/cloned
  // voices remain manual and must belong to the selected model and region.
  // https://www.alibabacloud.com/help/en/model-studio/non-realtime-tts-user-guide
  if (protocol === 'qwen-tts') return isQwenHttpModel(modelId) ? ['Cherry'] : [];
  if (protocol === 'dashscope-tts') {
    if (['cosyvoice-v3-plus', 'cosyvoice-v3-flash'].includes(modelId)) return ['longanyang'];
    if (modelId === 'qwen-audio-3.1-tts-flash') return ['longanhuan_v3.1'];
    return []; // Including CosyVoice 3.5: requires a voice bound to that model.
  }
  if (protocol !== 'openai') return [];
  if (/^gpt-4o-mini-tts(?:-\d{4}-\d{2}-\d{2})?$/.test(modelId)) return EXPRESSIVE;
  if (/^tts-1(?:-hd)?(?:-1106)?$/.test(modelId)) return STANDARD;
  return [];
}
