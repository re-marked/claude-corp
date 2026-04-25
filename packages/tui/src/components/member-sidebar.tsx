import React, { useState, useEffect } from 'react';
import { Box, Text } from '@claude-code-kit/ink-renderer';
import { getRole, type Member } from '@claudecorp/shared';
import { COLORS, STATUS, BORDER_STYLE } from '../theme.js';
import type { DaemonClient } from '../lib/daemon-client.js';

interface Props {
  members: Member[];
  channelMemberIds: string[];
  visible: boolean;
  daemonClient: DaemonClient;
}

export function MemberSidebar({ members, channelMemberIds, visible, daemonClient }: Props) {
  const [agentStatuses, setAgentStatuses] = useState<Record<string, string>>({});

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
          return (
            <Box key={`role-${roleId}`} gap={0} marginBottom={0}>
              <Text color={COLORS.muted}>•</Text>
              <Text> </Text>
              <Text color={COLORS.text} wrap="end">
                {label}
              </Text>
              <Text> </Text>
              <Text color={COLORS.muted} wrap="end">
                {slots.length} ({genFragment})
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text color={COLORS.muted}>Press 'm' to hide</Text>
      </Box>
    </Box>
  );
}