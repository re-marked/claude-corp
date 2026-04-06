/**
 * Format a tool call into a human-readable message for chat history.
 * Shared between router.ts and api.ts (say endpoint).
 */

export function formatToolMessage(toolName: string, args?: Record<string, unknown>): string {
  const name = toolName.toLowerCase();

  // File operations
  if (name === 'write' || name === 'create' || name === 'write_file') {
    return `wrote ${args?.path ?? args?.file_path ?? args?.filePath ?? 'a file'}`;
  }
  if (name === 'edit' || name === 'edit_file' || name === 'patch') {
    return `edited ${args?.path ?? args?.file_path ?? args?.filePath ?? 'a file'}`;
  }
  if (name === 'read' || name === 'read_file') {
    return `read ${args?.path ?? args?.file_path ?? args?.filePath ?? 'a file'}`;
  }

  // Commands / exec
  if (name === 'bash' || name === 'execute' || name === 'exec' || name === 'shell' || name === 'run') {
    const cmd = String(args?.command ?? args?.cmd ?? args?.input ?? '').trim();
    if (cmd) {
      const short = cmd.split('\n')[0]!.substring(0, 80);
      return `ran \`${short}\``;
    }
    return 'ran a command';
  }

  // Search
  if (name === 'glob' || name === 'search' || name === 'find') {
    return `searched ${args?.pattern ?? args?.query ?? 'files'}`;
  }
  if (name === 'grep') {
    return `searched for "${args?.pattern ?? args?.query ?? '...'}"`;
  }

  // Web
  if (name === 'web_search' || name === 'websearch') {
    return `searched web: "${args?.query ?? '...'}"`;
  }
  if (name === 'web_fetch' || name === 'fetch' || name === 'curl') {
    return `fetched ${args?.url ?? 'a URL'}`;
  }

  // Message / communication
  if (name === 'message' || name === 'send') {
    return `sent a message`;
  }

  // Process management
  if (name === 'process') {
    return `used process`;
  }

  // Fallback — try to extract something useful from args
  const path = args?.path ?? args?.file_path ?? args?.filePath;
  if (path) return `${name} ${path}`;
  const cmd = args?.command ?? args?.cmd;
  if (cmd) return `${name}: ${String(cmd).substring(0, 60)}`;

  return `used ${toolName}`;
}
