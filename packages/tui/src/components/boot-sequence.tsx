import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../theme.js';

const LOGO = [
  '           mmmm                                mm                                                             ',
  '           ""##                                ##                                                             ',
  '  m#####m    ##       m#####m  ##    ##   m###m##   m####m              m#####m   m####m    ##m####  ##m###m  ',
  ' ##"    "    ##       " mmm##  ##    ##  ##"  "##  ##mmmm##            ##"    "  ##"  "##   ##"      ##"  "## ',
  ' ##          ##      m##"""##  ##    ##  ##    ##  ##""""""            ##        ##    ##   ##       ##    ## ',
  ' "##mmmm#    ##mmm   ##mmm###  ##mmm###  "##mm###  "##mmmm#            "##mmmm#  "##mm##"   ##       ###mm##" ',
  '   """""      """"    """" ""   """" ""    """ ""    """""               """""     """"     ""       ## """   ',
  '                                                                                                     ##       ',
];

const PHASES = [
  'igniting core',
  'loading identity',
  'spawning agents',
  'connecting synapses',
  'going online',
];

interface Props {
  onComplete: () => void;
}

export function BootSequence({ onComplete }: Props) {
  const [logoLines, setLogoLines] = useState(0);
  const [phase, setPhase] = useState(-1);
  const [dots, setDots] = useState(0);

  // Logo line-by-line reveal
  useEffect(() => {
    if (logoLines >= LOGO.length) {
      setTimeout(() => setPhase(0), 300);
      return;
    }
    const timer = setTimeout(() => setLogoLines(l => l + 1), 150);
    return () => clearTimeout(timer);
  }, [logoLines]);

  // Progress through phases
  useEffect(() => {
    if (phase < 0 || phase >= PHASES.length) return;
    const duration = [500, 400, 600, 400, 300][phase] ?? 400;
    const timer = setTimeout(() => {
      if (phase === PHASES.length - 1) {
        setTimeout(onComplete, 600);
      }
      setPhase(p => p + 1);
    }, duration);
    return () => clearTimeout(timer);
  }, [phase]);

  // Dot animation
  useEffect(() => {
    const timer = setInterval(() => setDots(d => (d + 1) % 4), 250);
    return () => clearInterval(timer);
  }, []);

  const dotStr = '.'.repeat(dots);

  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
      {/* Logo */}
      <Box flexDirection="column" alignItems="center">
        {LOGO.slice(0, logoLines).map((line, i) => (
          <Text key={i} color={COLORS.primary}>{line}</Text>
        ))}
      </Box>

      {/* Phases */}
      {phase >= 0 && (
        <Box flexDirection="column" alignItems="center" marginTop={2}>
          {PHASES.slice(0, Math.min(phase + 1, PHASES.length)).map((p, i) => {
            const done = i < phase;
            const active = i === phase && phase < PHASES.length;
            return (
              <Text key={i} color={done ? COLORS.muted : active ? COLORS.text : COLORS.muted}>
                {done ? '  ' : '> '}{p}{active ? dotStr : ''}
              </Text>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
