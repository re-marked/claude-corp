import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../theme.js';

interface Props {
  breadcrumbs: string[];
  hints: string;
}

export function StatusBar({ breadcrumbs, hints }: Props) {
  const crumbText = breadcrumbs.join(' › ');

  return (
    <Box borderStyle="round" borderColor={COLORS.border} paddingX={1} justifyContent="space-between">
      <Text color={COLORS.subtle}>{crumbText}</Text>
      <Text color={COLORS.muted}>{hints}</Text>
    </Box>
  );
}
