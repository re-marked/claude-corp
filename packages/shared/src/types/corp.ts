export type DmMode = 'jack' | 'async';

export interface Corporation {
  name: string;
  displayName: string;
  owner: string;
  ceo: string | null;
  description: string;
  theme: string;
  /** Default DM mode: 'jack' (persistent session, recommended) or 'async' (stateless dispatch) */
  defaultDmMode?: DmMode;
  createdAt: string;
}
