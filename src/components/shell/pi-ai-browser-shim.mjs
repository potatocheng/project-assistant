/**
 * Lightweight browser shim for `@mariozechner/pi-ai`.
 *
 * All model calls in this Tauri desktop app route through the Rust backend
 * (`execute('copilot_agent_turn')`) via `createRustProxyStreamFn`, so we only
 * bundle the pure-JS agent runtime utilities (EventStream, TypeBox validation,
 * streaming JSON parser) and exclude Node/cloud provider SDKs from the Webview.
 */
export { Type } from 'typebox';
export {
  EventStream,
  AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from '../../../node_modules/@mariozechner/pi-ai/dist/utils/event-stream.js';
export { validateToolArguments } from '../../../node_modules/@mariozechner/pi-ai/dist/utils/validation.js';
export { parseStreamingJson } from '../../../node_modules/@mariozechner/pi-ai/dist/utils/json-parse.js';

export function streamSimple() {
  throw new Error('Direct browser model streaming is disabled; use the Rust proxy streamFn.');
}
