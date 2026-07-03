export interface Feature {
  title: string;
  description: string;
}

export const differentiators: Feature[] = [
  {
    title: 'Self-Directed',
    description: 'Define a goal. Nova breaks it into subtasks, executes autonomously, re-plans as needed.',
  },
  {
    title: 'Self-Improving',
    description: 'Learns your preferences, customizes itself, updates its own configuration over time.',
  },
  {
    title: 'Private & Secure',
    description: 'Runs on your hardware. Your data never leaves. Credentialed actions land in an HMAC-chained audit log; mutating actions require explicit user consent.',
  },
  {
    title: 'Parallel By Design',
    description: 'Continuous batching, concurrent pipelines, multiple inference backends. No bottleneck.',
  },
];

export const features: Feature[] = [
  {
    title: 'Managed Local Inference',
    description: 'vLLM, Ollama, or cloud — select from the UI. Nova handles container lifecycle, health monitoring, and graceful backend switching.',
  },
  {
    title: 'Capability Platform',
    description: 'Consent gate for mutating tool calls. Encrypted credential vault. Hash-chained audit log. GitHub provider with READ/PROPOSE/MUTATE/SETUP tiers.',
  },
  {
    title: 'Autonomous CI Triage',
    description: 'Cortex watches GitHub webhooks; failing CI dispatches a goal that proposes a fix PR. Per-cycle cost budget; nothing merges without your approval.',
  },
  {
    title: 'Personal Context Capture',
    description: 'Optional screenpipe-bridge ingests your screen activity into Nova\'s memory with a privacy denylist (apps, URL patterns, window titles) and pause-without-disconnect.',
  },
  {
    title: 'Markdown Memory',
    description: 'Memory as a folder of markdown files with OKF frontmatter — human-readable, git-trackable, BM25 retrieval with no embeddings required. Edit it with any editor; the index self-heals.',
  },
  {
    title: 'MCP Tool Ecosystem',
    description: 'Plug in any MCP server: GitHub, Slack, Sentry, Playwright, Docker, and more.',
  },
  {
    title: 'Multi-Provider LLM Routing',
    description: 'Anthropic, OpenAI, Ollama, Groq, Gemini, Cerebras, OpenRouter, plus subscription-based Claude/ChatGPT.',
  },
  {
    title: 'GPU-Aware Setup',
    description: 'Auto-detects GPU hardware, recommends inference backends, manages containers. Supports remote GPU over LAN with Wake-on-LAN.',
  },
  {
    title: 'Recovery & Resilience',
    description: 'Backup/restore, factory reset, service health monitoring via dedicated sidecar service. Docker SDK gated behind socket-proxy for blast-radius reduction.',
  },
  {
    title: 'IDE Integration',
    description: 'OpenAI-compatible endpoint works with Cursor, Continue.dev, Aider, and any OpenAI-API client.',
  },
  {
    title: 'Voice Conversation',
    description: 'Talk to Nova hands-free with Gemini-style conversation mode. Barge-in interruption, live transcription, auto-listen between turns.',
  },
];
