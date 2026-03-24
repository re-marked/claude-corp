import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { COLORS } from '../theme.js';

export type BootStyle = 'factory' | 'diagnostic';

interface Step {
  label: string;
  doneLabel: string;
}

const FACTORY_STEPS: Step[] = [
  { label: 'Lighting the furnace', doneLabel: 'Furnace lit' },
  { label: 'Pressurizing pipes', doneLabel: 'Pipes pressurized' },
  { label: 'Workers clocking in', doneLabel: 'Workers clocking in' },
  { label: 'Conveyor belts starting', doneLabel: 'Conveyor belts online' },
  { label: 'Opening factory floor', doneLabel: 'Factory floor ready' },
];

const DIAGNOSTIC_STEPS: Step[] = [
  { label: 'daemon', doneLabel: 'daemon' },
  { label: 'router', doneLabel: 'router' },
  { label: 'CEO', doneLabel: 'CEO' },
  { label: 'gateway', doneLabel: 'gateway' },
  { label: 'git snapshots', doneLabel: 'git snapshots' },
];

const DIAGNOSTIC_STATUS = ['OK', 'OK', 'ONLINE', 'READY', 'ACTIVE'];

// Each step spins for this long before completing — the animation's own clock
const STEP_DURATION_MS = 700;

interface Props {
  style: BootStyle;
  /** Called when the boot animation is done — parent can transition to the app */
  onComplete: () => void;
}

function ProgressBar({ progress, width = 16 }: { progress: number; width?: number }) {
  const filled = Math.round(progress * width);
  const empty = width - filled;
  return (
    <Text>
      <Text color={COLORS.success}>{'█'.repeat(filled)}</Text>
      <Text color="#3D4449">{'░'.repeat(empty)}</Text>
    </Text>
  );
}

export function BootSequence({ style, onComplete }: Props) {
  const [completedSteps, setCompletedSteps] = useState(0);
  const [barProgress, setBarProgress] = useState(0);
  const totalSteps = 5;

  // Animate: fill the progress bar for the current step, then mark it done
  useEffect(() => {
    if (completedSteps >= totalSteps) return;

    // Animate the progress bar from 0 to 1 over STEP_DURATION_MS
    const tickInterval = 50;
    const ticks = STEP_DURATION_MS / tickInterval;
    let tick = 0;

    const timer = setInterval(() => {
      tick++;
      setBarProgress(tick / ticks);
      if (tick >= ticks) {
        clearInterval(timer);
        setBarProgress(0);
        setCompletedSteps((s) => s + 1);
      }
    }, tickInterval);

    return () => clearInterval(timer);
  }, [completedSteps]);

  // When all steps done, hold for a beat then call onComplete
  useEffect(() => {
    if (completedSteps < totalSteps) return;
    const timer = setTimeout(onComplete, 600);
    return () => clearTimeout(timer);
  }, [completedSteps]);

  const steps = style === 'factory' ? FACTORY_STEPS : DIAGNOSTIC_STEPS;
  const allDone = completedSteps >= totalSteps;

  if (style === 'factory') {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
        <Box flexDirection="column" paddingX={2} paddingY={1}>
          <Text color={COLORS.primary} bold>
            {'\u2699'} Powering up...
          </Text>
          <Text> </Text>
          {steps.map((step, i) => {
            const done = i < completedSteps;
            const active = i === completedSteps && !allDone;
            return (
              <Box key={i} gap={1}>
                <Text color={done ? COLORS.success : active ? COLORS.primary : '#3D4449'}>
                  {done ? '\u2714' : active ? '\u25B8' : '\u25CB'}
                </Text>
                <Text color={done ? COLORS.text : active ? COLORS.subtle : '#3D4449'}>
                  {done ? step.doneLabel : step.label}
                </Text>
                {active && <Text color={COLORS.muted}> <Spinner type="dots" /></Text>}
              </Box>
            );
          })}
          {allDone && (
            <>
              <Text> </Text>
              <Text color={COLORS.success} bold>Factory operational.</Text>
            </>
          )}
        </Box>
      </Box>
    );
  }

  // diagnostic style
  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color={COLORS.primary} bold>CLAUDE CORP v0.4.3</Text>
        <Text color={COLORS.muted}>{'═'.repeat(22)}</Text>
        <Text> </Text>
        {steps.map((step, i) => {
          const done = i < completedSteps;
          const active = i === completedSteps && !allDone;
          const progress = done ? 1 : active ? barProgress : 0;
          return (
            <Box key={i} gap={1}>
              <Text color={done ? COLORS.text : active ? COLORS.subtle : '#3D4449'}>
                {step.label.padEnd(15)}
              </Text>
              <ProgressBar progress={progress} />
              <Text color={done ? COLORS.success : '#3D4449'} bold={done}>
                {done ? ` ${DIAGNOSTIC_STATUS[i]}` : ''}
              </Text>
            </Box>
          );
        })}
        {allDone && (
          <>
            <Text> </Text>
            <Text color={COLORS.success} bold>All systems operational.</Text>
          </>
        )}
      </Box>
    </Box>
  );
}

/** Parse --boot flag from process.argv */
export function getBootStyle(): BootStyle | null {
  const idx = process.argv.indexOf('--boot');
  if (idx === -1) return null;
  const val = process.argv[idx + 1];
  if (val === 'factory' || val === 'diagnostic') return val;
  return null;
}
