import {
  createNativeAcpAdapter,
  findNativeExecutable,
  nativeMetadata,
  NativeAgentError,
  type NativeAdapterOptions,
  type NativeSpawn,
  type NativeSpawnOptions,
} from './acp.js';
import { NATIVE_AGENT_DEFINITIONS } from './definitions.js';

const definition = NATIVE_AGENT_DEFINITIONS.codebuddy;
export const CODEBUDDY_ADAPTER_ID = definition.id;
export const CODEBUDDY_METADATA = nativeMetadata(definition);
export { NativeAgentError as CodeBuddyAdapterError };
export type CodeBuddyAdapterOptions = NativeAdapterOptions;
export type CodeBuddySpawnProcess = NativeSpawn;
export type CodeBuddySpawnOptions = NativeSpawnOptions;
export const findCodeBuddyExecutable = (options: NativeAdapterOptions = {}) =>
  findNativeExecutable(definition, options);
export const createCodeBuddyAdapter = (options: NativeAdapterOptions = {}) =>
  createNativeAcpAdapter(definition, options);
