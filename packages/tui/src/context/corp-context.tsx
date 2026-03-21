import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { join } from 'node:path';
import {
  type Member,
  type Channel,
  type Corporation,
  readConfig,
  readConfigOr,
  MEMBERS_JSON,
  CHANNELS_JSON,
  CORP_JSON,
} from '@claudecorp/shared';
import type { DaemonClient } from '../lib/daemon-client.js';

interface CorpContextValue {
  corpRoot: string;
  corp: Corporation | null;
  members: Member[];
  channels: Channel[];
  daemonClient: DaemonClient;
  daemonPort: number;
  /** Refresh members from disk */
  refreshMembers: () => void;
  /** Refresh channels from disk */
  refreshChannels: () => void;
}

const CorpContext = createContext<CorpContextValue | null>(null);

export function useCorp(): CorpContextValue {
  const ctx = useContext(CorpContext);
  if (!ctx) throw new Error('useCorp must be used within CorpProvider');
  return ctx;
}

interface ProviderProps {
  corpRoot: string;
  daemonClient: DaemonClient;
  daemonPort: number;
  initialMembers: Member[];
  initialChannels: Channel[];
  children: React.ReactNode;
}

export function CorpProvider({
  corpRoot,
  daemonClient,
  daemonPort,
  initialMembers,
  initialChannels,
  children,
}: ProviderProps) {
  const [members, setMembers] = useState<Member[]>(initialMembers);
  const [channels, setChannels] = useState<Channel[]>(initialChannels);
  const [corp, setCorp] = useState<Corporation | null>(null);

  // Load corp data on mount
  useEffect(() => {
    try {
      setCorp(readConfig<Corporation>(join(corpRoot, CORP_JSON)));
    } catch {
      /* corp.json may not exist yet */
    }
  }, [corpRoot]);

  const refreshMembers = useCallback(() => {
    try {
      setMembers(readConfigOr<Member[]>(join(corpRoot, MEMBERS_JSON), []));
    } catch {
      /* keep current state on read failure */
    }
  }, [corpRoot]);

  const refreshChannels = useCallback(() => {
    try {
      setChannels(readConfigOr<Channel[]>(join(corpRoot, CHANNELS_JSON), []));
    } catch {
      /* keep current state on read failure */
    }
  }, [corpRoot]);

  const value: CorpContextValue = {
    corpRoot,
    corp,
    members,
    channels,
    daemonClient,
    daemonPort,
    refreshMembers,
    refreshChannels,
  };

  return <CorpContext.Provider value={value}>{children}</CorpContext.Provider>;
}
