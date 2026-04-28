import React, { useState, useEffect } from 'react';
import { Box, Text } from '@claude-code-kit/ink-renderer';
import {
  getRole,
  listActiveBreakers,
  rankQueue,
  readClearinghouseLock,
  queryChits,
  type Member,
  type Chit,
} from '@claudecorp/shared';
import { COLORS, STATUS, BORDER_STYLE } from '../theme.js';
import type { DaemonClient } from '../lib/daemon-client.js';

interface Props {
  members: Member[];
  channelMemberIds: string[];
  visible: boolean;
  daemonClient: DaemonClient;
  /** Project 1.11: corp root for reading active breaker chits. Optional — sidebar degrades to no tripped indicators when absent. */
  corpRoot?: string;
}

export function MemberSidebar({ members, channelMemberIds, visible, daemonClient, corpRoot }: Props) {
  const [agentStatuses, setAgentStatuses] = useState<Record<string, string>>({});
  const [trippedSlugs, setTrippedSlugs] = useState<Set<string>>(new Set());
  // Project 1.12.3: clearinghouse lane snapshot for the sidebar.
  // Queue depth + in-flight + recent-merge count + open-blocker
  // count, refreshed on the same cadence as the rest of the
  // sidebar reads. Empty initial state so the sidebar renders
  // before the first read completes.
  const [laneSnapshot, setLaneSnapshot] = useState<{
    queueDepth: number;
    lockHeldBy: string | null;
    recentMerges: number;
    openBlockers: number;
    editorInFlight: number;
  }>({ queueDepth: 0, lockHeldBy: null, recentMerges: 0, openBlockers: 0, editorInFlight: 0 });

  // Fetch real-time agent statuses from daemon
  useEffect(() => {
    if (!visible) return;

    const fetchStatuses = async () => {
      try {
        const agentList = await daemonClient.listAgents();
        const statusMap: Record<string, string> = {};
        agentList.forEach(agent => {
          statusMap[agent.memberId] = agent.status;
        });
        setAgentStatuses(statusMap);
      } catch (error) {
        // Fail silently - use fallback status from members.json
      }
    };

    fetchStatuses();
    // Refresh every 10 seconds while sidebar is visible
    const interval = setInterval(fetchStatuses, 10000);

    return () => clearInterval(interval);
  }, [visible, daemonClient]);

  // Project 1.11: read active breaker trips from disk on the same
  // 10s cadence as agent statuses. listActiveBreakers fails open
  // (returns []) on corruption, so this never throws to the
  // render path.
  useEffect(() => {
    if (!visible || !corpRoot) return;
    const fetchBreakers = () => {
      const trips = listActiveBreakers(corpRoot);
      setTrippedSlugs(new Set(trips.map((t) => t.fields['breaker-trip'].slug)));
    };
    fetchBreakers();
    const interval = setInterval(fetchBreakers, 10000);
    return () => clearInterval(interval);
  }, [visible, corpRoot]);

  // Project 1.12.3: clearinghouse lane snapshot. Reads queue +
  // lock + recent lane-events on the same 10s cadence; fails open
  // on any read error so a corrupt chit never throws to render.
  useEffect(() => {
    if (!visible || !corpRoot) return;
    const fetchLane = () => {
      try {
        const queue = rankQueue(corpRoot);
        const lock = readClearinghouseLock(corpRoot);
        // Recent merges: submission-finalized events in the last hour.
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const events = queryChits<'lane-event'>(corpRoot, {
          types: ['lane-event'],
          scopes: ['corp'],
        });
        let recentMerges = 0;
        for (const e of events.chits) {
          const ev = e.chit as Chit<'lane-event'>;
          if (ev.fields['lane-event'].kind !== 'submission-finalized') continue;
          if ((ev.createdAt ?? '') < oneHourAgo) continue;
          recentMerges++;
        }
        // Open blockers: clearance-submission chits with submissionStatus
        // === 'conflict' (terminal-but-recoverable; awaiting author).
        const subs = queryChits<'clearance-submission'>(corpRoot, {
          types: ['clearance-submission'],
          scopes: ['corp'],
          statuses: ['active'],
        });
        let openBlockers = 0;
        for (const s of subs.chits) {
          const f = (s.chit as Chit<'clearance-submission'>).fields['clearance-submission'];
          if (f.submissionStatus === 'conflict') openBlockers++;
        }
        // Editor in-flight: tasks with non-null reviewerClaim.
        const tasks = queryChits<'task'>(corpRoot, {
          types: ['task'],
          statuses: ['active'],
        });
        let editorInFlight = 0;
        for (const t of tasks.chits) {
          const f = (t.chit as Chit<'task'>).fields.task;
          if ((f.reviewerClaim ?? null) !== null) editorInFlight++;
        }
        setLaneSnapshot({
          queueDepth: queue.length,
          lockHeldBy: lock.heldBy,
          recentMerges,
          openBlockers,
          editorInFlight,
        });
      } catch {
        // Fail open — leave previous snapshot in place.
      }
    };
    fetchLane();
    const interval = setInterval(fetchLane, 10000);
    return () => clearInterval(interval);
  }, [visible, corpRoot]);

  if (!visible) return null;

  // Filter members to only those in this channel
  const channelMembers = members.filter(member => 
    channelMemberIds.includes(member.id)
  );

  // Sort by type (users first), then by rank hierarchy, then by name
  const rankOrder: Record<string, number> = {
    'owner': 0,
    'master': 1,
    'leader': 2,
    'worker': 3,
    'subagent': 4
  };

  // Project 1.10.4: split into named members (users + Partners) and
  // role-pool employees. Named members render individually; employees
  // collapse into a per-role rollup so a 12-slot Backend Engineer
  // pool occupies one line, not twelve. Founder sees the corp scale
  // without the sidebar growing with it.
  const named: Member[] = [];
  const employeesByRole = new Map<string, Member[]>();
  for (const m of channelMembers) {
    if (m.type === 'user' || (m.kind ?? 'partner') === 'partner') {
      named.push(m);
      continue;
    }
    // Employee — group by role. Untyped/missing role falls into a
    // synthetic 'unassigned' bucket so the slot doesn't disappear.
    const roleId = m.role ?? 'unassigned';
    const list = employeesByRole.get(roleId) ?? [];
    list.push(m);
    employeesByRole.set(roleId, list);
  }

  const sortedNamed = named.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'user' ? -1 : 1;
    const rankA = rankOrder[a.rank] ?? 99;
    const rankB = rankOrder[b.rank] ?? 99;
    if (rankA !== rankB) return rankA - rankB;
    return a.displayName.localeCompare(b.displayName);
  });

  const sortedRoles = [...employeesByRole.keys()].sort();

  return (
    <Box
      flexDirection="column"
      width={20}
      borderStyle={BORDER_STYLE}
      borderColor={COLORS.border}
      paddingX={1}
      paddingY={1}
    >
      <Box marginBottom={1}>
        <Text bold color={COLORS.primary}>Members</Text>
      </Box>

      <Box flexDirection="column">
        {sortedNamed.map((member) => {
          const isUser = member.type === 'user';
          // For agents, use real-time status from daemon; for users, use 'active'
          const effectiveStatus = isUser
            ? 'active'
            : agentStatuses[member.id] || member.status;
          const statusKey = effectiveStatus as keyof typeof STATUS;
          const statusInfo = STATUS[statusKey] ?? STATUS.idle;

          return (
            <Box key={member.id} gap={0} marginBottom={0}>
              <Text color={statusInfo.color}>{statusInfo.icon}</Text>
              <Text> </Text>
              <Text
                color={isUser ? COLORS.user : COLORS.text}
                wrap="end"
              >
                {member.displayName}
              </Text>
              <Text> </Text>
              <Text color={COLORS.muted} wrap="end">
                {isUser ? 'founder' : member.rank}
              </Text>
            </Box>
          );
        })}

        {sortedRoles.map((roleId) => {
          const slots = employeesByRole.get(roleId)!;
          const role = getRole(roleId);
          const label = role?.displayName ?? roleId;
          const generations = slots.map((s) => s.generation ?? 0);
          const minGen = Math.min(...generations);
          const maxGen = Math.max(...generations);
          const genFragment =
            minGen === maxGen ? `gen ${minGen}` : `gens ${minGen}-${maxGen}`;
          // Project 1.11: tripped count for the role rollup. Counted
          // from active breaker chits intersected with this role's
          // current slots — a trip whose Member was already removed
          // doesn't inflate the role's tripped count.
          const trippedCount = slots.filter((s) => trippedSlugs.has(s.id)).length;
          const activeCount = slots.length - trippedCount;
          // Use the broken status icon when ANY slot in the role is
          // tripped; otherwise the neutral muted bullet.
          const bulletColor = trippedCount > 0 ? STATUS.broken.color : COLORS.muted;
          const bulletIcon = trippedCount > 0 ? STATUS.broken.icon : '•';
          const summaryText = trippedCount > 0
            ? `${activeCount} active, ${trippedCount} tripped (${genFragment})`
            : `${slots.length} (${genFragment})`;
          return (
            <Box key={`role-${roleId}`} gap={0} marginBottom={0}>
              <Text color={bulletColor}>{bulletIcon}</Text>
              <Text> </Text>
              <Text color={COLORS.text} wrap="end">
                {label}
              </Text>
              <Text> </Text>
              <Text color={COLORS.muted} wrap="end">
                {summaryText}
              </Text>
            </Box>
          );
        })}
      </Box>

      {(laneSnapshot.queueDepth > 0
        || laneSnapshot.lockHeldBy !== null
        || laneSnapshot.recentMerges > 0
        || laneSnapshot.openBlockers > 0
        || laneSnapshot.editorInFlight > 0) && (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text bold color={COLORS.primary}>Lane</Text>
          </Box>
          {laneSnapshot.queueDepth > 0 && (
            <Box gap={0}>
              <Text color={COLORS.muted}>•</Text>
              <Text> </Text>
              <Text color={COLORS.text}>Queue</Text>
              <Text> </Text>
              <Text color={COLORS.muted} wrap="end">{laneSnapshot.queueDepth}</Text>
            </Box>
          )}
          {laneSnapshot.lockHeldBy !== null && (
            <Box gap={0}>
              <Text color={STATUS.working?.color ?? COLORS.muted}>●</Text>
              <Text> </Text>
              <Text color={COLORS.text} wrap="end">In flight</Text>
            </Box>
          )}
          {laneSnapshot.editorInFlight > 0 && (
            <Box gap={0}>
              <Text color={COLORS.muted}>•</Text>
              <Text> </Text>
              <Text color={COLORS.text}>Reviews</Text>
              <Text> </Text>
              <Text color={COLORS.muted} wrap="end">{laneSnapshot.editorInFlight}</Text>
            </Box>
          )}
          {laneSnapshot.recentMerges > 0 && (
            <Box gap={0}>
              <Text color={COLORS.muted}>•</Text>
              <Text> </Text>
              <Text color={COLORS.text}>Merged 1h</Text>
              <Text> </Text>
              <Text color={COLORS.muted} wrap="end">{laneSnapshot.recentMerges}</Text>
            </Box>
          )}
          {laneSnapshot.openBlockers > 0 && (
            <Box gap={0}>
              <Text color={STATUS.broken?.color ?? COLORS.muted}>{STATUS.broken?.icon ?? '!'}</Text>
              <Text> </Text>
              <Text color={COLORS.text}>Blockers</Text>
              <Text> </Text>
              <Text color={COLORS.muted} wrap="end">{laneSnapshot.openBlockers}</Text>
            </Box>
          )}
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={COLORS.muted}>Press 'm' to hide</Text>
      </Box>
    </Box>
  );
}