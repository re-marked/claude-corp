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
  };
  /** Auto-detected from ~/.openclaw/openclaw.json — not persisted to disk */
  userGateway?: {
    port: number;
    token: string;
  };
}
