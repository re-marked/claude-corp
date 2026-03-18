import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { type Member, readConfig, buildHierarchy, type HierarchyNode, MEMBERS_JSON } from '@agentcorp/shared';
import { join } from 'node:path';
import { COLORS, STATUS, BORDER_STYLE } from '../theme.js';
import type { View } from '../navigation.js';

interface Props {
  corpRoot: string;
  onNavigate: (view: View) => void;
  onBack: () => void;
}

interface FlatNode {
  member: Member;
  prefix: string;
  depth: number;
}

function flattenTree(node: HierarchyNode, prefix = '', isLast = true, depth = 0): FlatNode[] {
  const result: FlatNode[] = [];

  const connector = depth === 0 ? '' : isLast ? '└── ' : '├── ';
  result.push({ member: node.member, prefix: prefix + connector, depth });

  const childPrefix = depth === 0 ? '' : prefix + (isLast ? '    ' : '│   ');

  node.children.forEach((child, i) => {
    const childIsLast = i === node.children.length - 1;
    result.push(...flattenTree(child, childPrefix, childIsLast, depth + 1));
  });

  return result;
}

export function HierarchyView({ corpRoot, onNavigate, onBack }: Props) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const members = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));
  const tree = buildHierarchy(members);
  const flat = tree ? flattenTree(tree) : [];

  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setSelectedIndex((i) => Math.min(flat.length - 1, i + 1));
    } else if (key.return) {
      const node = flat[selectedIndex];
      if (node && node.member.type === 'agent') {
        onNavigate({ type: 'agent-inspector', memberId: node.member.id });
      }
    } else if (key.escape || input === 'q') {
      onBack();
    }
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box borderStyle={BORDER_STYLE} borderColor={COLORS.border} paddingX={1}>
        <Text bold color={COLORS.primary}>Hierarchy</Text>
        <Text color={COLORS.muted}>  {members.filter((m) => m.type === 'agent').length} agents</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingX={1} paddingY={1}>
        {flat.map((node, i) => {
          const isSelected = i === selectedIndex;
          const statusKey = node.member.status as keyof typeof STATUS;
          const statusInfo = STATUS[statusKey] ?? STATUS.idle;
          const isUser = node.member.type === 'user';

          return (
            <Box key={node.member.id} gap={0}>
              <Text color={COLORS.muted}>{node.prefix}</Text>
              <Text
                bold={isSelected}
                color={isSelected ? COLORS.primary : isUser ? COLORS.user : COLORS.text}
              >
                {node.member.displayName}
              </Text>
              <Text> </Text>
              {!isUser && (
                <>
                  <Text color={statusInfo.color}>{statusInfo.icon}</Text>
                  <Text color={COLORS.muted}> {node.member.rank}</Text>
                </>
              )}
              {isUser && <Text color={COLORS.muted}>founder</Text>}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
