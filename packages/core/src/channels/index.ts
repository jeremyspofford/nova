// M6 channels and event triggers (seams in types.ts): channel bindings and adapters (FR-088),
// event triggers (FR-056), MCP event subscriptions (FR-201) and notification routing (FR-060).
export * from './types.ts';
export {
  type AdapterProbe,
  type BindingCredentials,
  type ChannelAdapterExtras,
  type NovaChannelAdapter,
} from './adapters/common.ts';
export { SLACK_API, SlackAdapter, type SlackAdapterOptions } from './adapters/slack.ts';
export {
  BOT_FRAMEWORK_OPENID,
  BOT_FRAMEWORK_TOKEN_URL,
  BotFrameworkVerifier,
  TeamsAdapter,
  defaultServiceHost,
  type BotFrameworkVerifierOptions,
  type TeamsAdapterOptions,
  type TeamsTokenVerifier,
} from './adapters/teams.ts';
export { WebhookAdapter, type WebhookAdapterOptions } from './adapters/webhook.ts';
export { EMAIL_UNAVAILABLE, EmailAdapter, InAppAdapter } from './adapters/simple.ts';
export {
  answerableFromChannel,
  approvalCode,
  approvalPrompt,
  parseAnswer,
  type ChannelAnswer,
  type ChannelDecision,
} from './answers.ts';
export {
  ChannelService,
  type BindingThreadResolver,
  type ChannelBindingInfo,
  type ChannelInboundGuard,
  type ChannelServiceOptions,
  type ChannelSetting,
  type ConnectorListener,
  type ReceiveOutcome,
  type ShareAsk,
} from './service.ts';
export {
  overlapPrivacyCheck,
  type PrivateOriginCheck,
  type PrivateOriginInput,
  type PrivateSource,
} from './privacy.ts';
export {
  TriggerService,
  type AgentThreadResolver,
  type FireOutcome,
  type TriggerEvent,
  type TriggerServiceOptions,
  type TriggerSubscriptions,
} from './triggers.ts';
export {
  MCP_DELIVERY_HEADERS,
  MCP_DELIVERY_MAX_BYTES,
  McpEventService,
  signMcpDelivery,
  type DeliveryOutcome,
  type McpEventInfo,
  type McpEventServiceOptions,
  type McpEventSource,
  type SubscriptionTimers,
} from './mcp-events.ts';
export {
  NotificationRouter,
  quietWindow,
  type NotificationRouterOptions,
  type NotificationSender,
  type QuietHoursState,
  type RouteDecision,
} from './notify.ts';
export { channelDelivery, type DeliverySender } from './delivery.ts';
export { channelToolSource, channelTools } from './tools.ts';
