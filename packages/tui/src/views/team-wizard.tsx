import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { Member } from '@claudecorp/shared';
import type { DaemonClient } from '../lib/daemon-client.js';
import { COLORS, BORDER_STYLE } from '../theme.js';

type Step = 'loading' | 'project' | 'name' | 'leader' | 'creating' | 'done' | 'error';

interface ProjectEntry {
  id: string;
  name: string;
  displayName: string;
}

interface Props {
  daemonClient: DaemonClient;
  founderId: string;
  members: Member[];
  onClose: () => void;
  onCreated: (name: string) => void;
}

export function TeamWizard({ daemonClient, founderId, members, onClose, onCreated }: Props) {
  const [step, setStep] = useState<Step>('loading');
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [projectIndex, setProjectIndex] = useState(0);
  const [name, setName] = useState('');
  const [leaderIndex, setLeaderIndex] = useState(0);
  const [error, setError] = useState('');

  const agents = members.filter((m) => m.type === 'agent');

  // Load projects on mount
  useEffect(() => {
    (async () => {
      try {
        const list = await daemonClient.listProjects() as ProjectEntry[];
        setProjects(list);
        if (list.length === 0) {
          setError('No projects exist. Create a project first with /project.');
          setStep('error');
        } else {
          setStep('project');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStep('error');
      }
    })();
  }, []);

  useInput((_input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (step === 'project') {
      if (key.upArrow) {
        setProjectIndex((i) => Math.max(0, i - 1));
      } else if (key.downArrow) {
        setProjectIndex((i) => Math.min(projects.length - 1, i + 1));
      } else if (key.return) {
        setStep('name');
      }
    }

    if (step === 'leader') {
      if (key.upArrow) {
        setLeaderIndex((i) => Math.max(0, i - 1));
      } else if (key.downArrow) {
        setLeaderIndex((i) => Math.min(agents.length - 1, i + 1));
      } else if (key.return) {
        void handleSubmit();
      }
    }
  });

  const handleNameSubmit = (val: string) => {
    const trimmed = val.trim();
    if (!trimmed) return;
    setName(trimmed);
    if (agents.length === 0) {
      setError('No agents available to lead a team. Hire an agent first with /hire.');
      setStep('error');
      return;
    }
    setStep('leader');
  };

  const handleSubmit = async () => {
    setStep('creating');

    const project = projects[projectIndex];
    const leader = agents[leaderIndex];
    if (!project || !leader) {
      setError('Invalid selection');
      setStep('error');
      return;
    }

    try {
      await daemonClient.createTeam({
        projectId: project.id,
        name,
        leaderId: leader.id,
        createdBy: founderId,
      });
      setStep('done');
      onCreated(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('error');
    }
  };

  return (
    <Box flexDirection="column" borderStyle={BORDER_STYLE} borderColor={COLORS.secondary} paddingX={2} paddingY={1} width={60}>
      <Box marginBottom={1}>
        <Text bold color={COLORS.secondary}>Create a Team</Text>
        <Text dimColor>  (Esc to cancel)</Text>
      </Box>

      {step === 'loading' && (
        <Text color={COLORS.subtle}>Loading projects...</Text>
      )}

      {step === 'project' && (
        <Box flexDirection="column">
          <Text>Select project:</Text>
          {projects.map((p, i) => (
            <Box key={p.id} gap={1}>
              <Text color={i === projectIndex ? COLORS.primary : undefined} bold={i === projectIndex}>
                {i === projectIndex ? '>' : ' '} {p.displayName}
              </Text>
              <Text dimColor>({p.name})</Text>
            </Box>
          ))}
          <Text dimColor marginTop={1}>up/down to select, Enter to confirm</Text>
        </Box>
      )}

      {step === 'name' && (
        <Box flexDirection="column">
          <Text>Project: <Text bold>{projects[projectIndex]?.displayName}</Text></Text>
          <Text marginTop={1}>Team name:</Text>
          <Box>
            <Text bold color={COLORS.success}>&gt; </Text>
            <TextInput
              value={name}
              onChange={setName}
              onSubmit={handleNameSubmit}
              placeholder="frontend"
            />
          </Box>
        </Box>
      )}

      {step === 'leader' && (
        <Box flexDirection="column">
          <Text>Project: <Text bold>{projects[projectIndex]?.displayName}</Text>  Team: <Text bold>{name}</Text></Text>
          <Text marginTop={1}>Select team leader:</Text>
          {agents.map((a, i) => (
            <Box key={a.id} gap={1}>
              <Text color={i === leaderIndex ? COLORS.primary : undefined} bold={i === leaderIndex}>
                {i === leaderIndex ? '>' : ' '} {a.displayName}
              </Text>
              <Text dimColor>({a.rank})</Text>
            </Box>
          ))}
          <Text dimColor marginTop={1}>up/down to select, Enter to confirm</Text>
        </Box>
      )}

      {step === 'creating' && (
        <Text color={COLORS.primary}>Creating team...</Text>
      )}

      {step === 'done' && (
        <Text color={COLORS.success}>Team <Text bold>"{name}"</Text> created! A team channel has been added.</Text>
      )}

      {step === 'error' && (
        <Text color={COLORS.danger}>Failed: {error}</Text>
      )}
    </Box>
  );
}
