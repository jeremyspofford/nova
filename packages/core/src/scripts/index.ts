// M7 scripted tool calls (FR-202; flagged, off by default): `script.run`, its isolated engine and
// the nested calls it makes through the tool runtime.
export {
  DEFAULT_SCRIPT_LIMITS,
  MAX_CALL_ARGS_CHARS,
  MAX_SCRIPT_CHARS,
  runScript,
  type BridgeAnswer,
  type ScriptBridge,
  type ScriptErrorCode,
  type ScriptLimits,
  type ScriptOutcome,
  type ScriptRequest,
} from './vm.ts';
export {
  MAX_INPUT_CHARS,
  WATCHDOG_GRACE_MS,
  resolveLimits,
  runIsolatedScript,
  type IsolatedScript,
} from './runner.ts';
export {
  SCRIPT_EXCLUDED_TOOLS,
  SCRIPT_TOOL_DESCRIPTION,
  nestedOrigin,
  runtimeNestedCaller,
  scriptTool,
  scriptToolSource,
  type NestedCallRecord,
  type NestedResult,
  type NestedSession,
  type NestedToolCaller,
  type ScriptToolOptions,
} from './tool.ts';
export { scriptRunView, scriptRunsOfThread, scriptRunsPage } from './views.ts';
