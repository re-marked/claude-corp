export interface GlobalConfig {
  apiKeys: {
    anthropic?: string;
    openai?: string;
    google?: string;
  };
  daemon: {
    portRange: [number, number];
    logLevel: 'debug' | 'info' | 'warn' | 'error';
  };
  defaults: {
    model: string;
    provider: string;
    /** Ordered fallback models when primary is unavailable/overloaded. */
    fallbackChain?: string[];
  };
  /** Auto-detected from ~/.openclaw/openclaw.json — not persisted to disk */
  userGateway?: {
    port: number;
    token: string;
  };
}
