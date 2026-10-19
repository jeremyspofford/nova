// M7 external agent adapters (FR-203; flagged, off by default): a Code session delegates to an
// external coding agent over the Agent Client Protocol, with every permission request and every
// operation decided by Nova's policy engine and the agent in the session's sandbox.
export {
  JsonRpcError,
  JsonRpcPeer,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_PARSE_ERROR,
  type JsonRpcPeerOptions,
  type LineTransport,
} from './jsonrpc.ts';
export {
  ACP_PROTOCOL_VERSION,
  STOP_REASONS,
  TOOL_KINDS,
  toolKind,
  type AcpToolCall,
  type InitializeResult,
  type PermissionRequest,
  type SessionUpdate,
  type StopReason,
  type ToolKind,
} from './protocol.ts';
export {
  AcpClient,
  AgentRefused,
  pickOption,
  type AcpClientOptions,
  type AcpHost,
  type PermissionAnswer,
  type TerminalOutput,
} from './client.ts';
export {
  ACP_DENIED,
  MAX_AGENT_TERMINALS,
  MAX_TERMINAL_OUTPUT,
  policyAcpHost,
  type PermissionDecision,
  type PolicyAcpHostOptions,
} from './host.ts';
export {
  AGENT_POLL_MS,
  agentCommandLine,
  agentSandbox,
  sandboxAgentLauncher,
  type AgentLaunch,
  type AgentLauncher,
  type AgentSandboxPick,
} from './launcher.ts';
export {
  DELEGATION_EVENT_INTERVAL_MS,
  ExternalAgentService,
  type AdapterSecrets,
  type ExternalAgentServiceOptions,
} from './service.ts';
