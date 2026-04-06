/**
 * TextInput — adapted from ink-text-input, using cck renderer.
 * Replaces chalk with Text props for cursor/placeholder styling.
 */

import React, { useState, useEffect } from 'react';
import { Text, useInput } from '@claude-code-kit/ink-renderer';

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  focus?: boolean;
}

export function TextInput({ value: originalValue, placeholder = '', onChange, onSubmit, focus = true }: TextInputProps) {
  const [cursorOffset, setCursorOffset] = useState(originalValue.length);

  useEffect(() => {
    if (cursorOffset > originalValue.length) {
      setCursorOffset(originalValue.length);
    }
  }, [originalValue]);

  useInput((input, key) => {
    if (key.upArrow || key.downArrow || (key.ctrl && input === 'c') || key.tab || (key.shift && key.tab)) {
      return;
    }

    if (key.return) {
      onSubmit?.(originalValue);
      return;
    }

    let nextOffset = cursorOffset;
    let nextValue = originalValue;

    if (key.leftArrow) {
      nextOffset = Math.max(0, nextOffset - 1);
    } else if (key.rightArrow) {
      nextOffset = Math.min(originalValue.length, nextOffset + 1);
    } else if (key.backspace || key.delete) {
      if (cursorOffset > 0) {
        nextValue = originalValue.slice(0, cursorOffset - 1) + originalValue.slice(cursorOffset);
        nextOffset--;
      }
    } else {
      nextValue = originalValue.slice(0, cursorOffset) + input + originalValue.slice(cursorOffset);
      nextOffset += input.length;
    }

    nextOffset = Math.max(0, Math.min(nextValue.length, nextOffset));
    setCursorOffset(nextOffset);

    if (nextValue !== originalValue) {
      onChange(nextValue);
    }
  }, { isActive: focus });

  // Empty value — show placeholder with cursor
  if (originalValue.length === 0) {
    if (placeholder.length > 0) {
      return (
        <Text>
          <Text inverse>{placeholder[0]}</Text>
          <Text color="gray">{placeholder.slice(1)}</Text>
        </Text>
      );
    }
    return <Text inverse> </Text>;
  }

  // Render value with cursor
  const before = originalValue.slice(0, cursorOffset);
  const cursorChar = cursorOffset < originalValue.length ? originalValue[cursorOffset] : ' ';
  const after = cursorOffset < originalValue.length ? originalValue.slice(cursorOffset + 1) : '';

  return (
    <Text>
      {before}
      <Text inverse>{cursorChar}</Text>
      {after}
    </Text>
  );
}
