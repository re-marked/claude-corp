export interface AgentConfig {
  memberId: string;
  displayName: string;
  model: string;
  provider: string;
  port: number | null;
  scope: 'corp' | 'project' | 'team';
  scopeId: string;
  /**
   * Registered harness name that executes turns for this agent. Optional
   * for backwards compatibility with agents created before PR 2; the
   * daemon's resolveHarnessForAgent falls back to corp-level default
   * then to 'openclaw' when missing.
   */
  harness?: string;
}
