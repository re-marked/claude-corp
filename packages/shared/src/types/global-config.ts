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
}
