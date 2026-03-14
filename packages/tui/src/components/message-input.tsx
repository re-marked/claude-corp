import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

interface Props {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function MessageInput({ onSend, disabled, placeholder }: Props) {
  const [value, setValue] = useState('');

  const handleSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');
  };

  return (
    <Box borderStyle="single" borderColor={disabled ? 'gray' : 'white'} paddingX={1}>
      <Text bold color="green">&gt; </Text>
      {disabled ? (
        <Text dimColor>{placeholder ?? 'Waiting...'}</Text>
      ) : (
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          placeholder={placeholder ?? 'Type a message...'}
        />
      )}
    </Box>
  );
}
