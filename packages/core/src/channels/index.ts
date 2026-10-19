// M6 channels and event triggers (seams in types.ts): channel bindings and adapters (FR-088),
// event triggers (FR-056), MCP event subscriptions (FR-201) and notification routing (FR-060).
// M7: Telegram and email adapters, approval buttons and signed links, pollers, push (FR-110,
// FR-111).
export * from './types.ts';
export {
  type AdapterProbe,
  type BindingCredentials,
  type ChannelAction,
  type ChannelAdapterExtras,
  type InboundAttachment,
  type NovaChannelAdapter,
  type NovaInboundMessage,
  type NovaOutboundMessage,
  type OutboundApproval,
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
export { InAppAdapter } from './adapters/simple.ts';
export { TELEGRAM_API, TelegramAdapter, type TelegramAdapterOptions } from './adapters/telegram.ts';
export { EmailAdapter, type EmailAdapterOptions } from './adapters/email.ts';
export {
  ImapReader,
  MAX_MESSAGE_BYTES,
  plainAllowed,
  type FetchedMail,
  type MailCursor,
  type MailReader,
  type MailboxAccess,
  type MailServer,
} from './adapters/mail/imap.ts';
export {
  NOVA_MAIL_HEADER,
  authservTrusted,
  parseAuthResults,
  parseMail,
  senderAuthenticated,
  stripComments,
  stripQuoted,
  type AuthResult,
  type ParseContext,
} from './adapters/mail/parse.ts';
export { ApprovalLinks, LINK_KEY_REF } from './approval-links.ts';
export { ChannelPollers, type ChannelPollersOptions } from './pollers.ts';
export * from './push/index.ts';
export {
  HUB_ONLY_TEXT,
  answerableFromChannel,
  approvalCode,
  approvalEmailText,
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
  type PushLeg,
  type NotificationSender,
  type QuietHoursState,
  type RouteDecision,
} from './notify.ts';
export { channelDelivery, type DeliverySender } from './delivery.ts';
export { channelToolSource, channelTools } from './tools.ts';
