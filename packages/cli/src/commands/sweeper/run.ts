/**
 * `cc-cli sweeper run <name>` — invoke a code sweeper.
 *
 * Thin wrapper around the daemon's /sweeper/run endpoint. The CLI
 * does no validation beyond "is there a name positional?" — the
 * daemon-side handler validates against the registry and returns
 * a 400 with the full list of known sweepers if the name is bad,
 * which we surface verbatim. No need to duplicate the registry
 * here.
 *
 * Output modes:
 *   - Default: human-readable. Prints status, summary, and a
 *     per-observation line showing category + subject + title.
 *   - --json: raw SweeperResult JSON. For scripting + for Sexton
 *     herself if she wants to parse the output in a structured way.
 *
 * Exit codes:
 *   0  completed or noop
 *   1  failed (sweeper ran and reported failure) or 400/500 from
 *      daemon (unknown name, network error, daemon down)
 *
 * Non-zero on failure lets Sexton's shell-script-y patrol logic
 * branch on success/failure without having to parse the summary.
 */

import { parseArgs } from 'node:util';
import { getClient } from '../../client.js';

interface SweeperResultShape {
  status: 'completed' | 'failed' | 'noop';
  summary: string;
  observations: ReadonlyArray<{
    category: string;
    subject: string;
    title: string;
    body: string;
    importance: number;
    tags?: readonly string[];
  }>;
}

const HELP = `cc-cli sweeper run — Invoke a code sweeper by name.

Usage:
  cc-cli sweeper run <name> [--json]

Arguments:
  <name>         Sweeper to invoke. Known names shown in
                 \`cc-cli sweeper\` help. Daemon validates + returns
                 the full list on 400 if the name is unknown.

Options:
  --json         Print the raw SweeperResult JSON instead of the
                 human-readable summary. Useful for scripting.
  --help         Show this help.

Exit codes:
  0   completed or noop
  1   failed (sweeper reported failure) OR daemon-side error
      (unknown name, network, 500)

Examples:
  cc-cli sweeper run silentexit
  cc-cli sweeper run silentexit --json
`;

export async function cmdSweeperRun(rawArgs: string[]): Promise<void> {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (parsed.values.help) {
    console.log(HELP);
    return;
  }

  const name = parsed.positionals[0];
  if (!name || name.length === 0) {
    console.error('cc-cli sweeper run: <name> is required.');
    console.error('');
    console.error(HELP);
    process.exit(1);
  }

  const client = getClient();
  let body: unknown;
  try {
    body = await client.post('/sweeper/run', { name });
  } catch (err) {
    console.error(
      `cc-cli sweeper run: could not reach the daemon — ${err instanceof Error ? err.message : String(err)}. ` +
        `Is \`cc-cli start\` running?`,
    );
    process.exit(1);
  }

  // Daemon's /sweeper/run returns { error } on 400/500 and the
  // SweeperResult shape on 200. Client.post gives us the body
  // either way; the shape tells us which path fired.
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error: string }).error;
    console.error(`cc-cli sweeper run: ${err}`);
    process.exit(1);
  }

  const result = body as SweeperResultShape;

  if (parsed.values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    // Status-coloring is nice-to-have but ANSI escapes look ugly
    // when the CLI is captured by an agent's tool output and parsed
    // as prose. Plain text; Sexton reads it fine either way.
    console.log(`[${result.status}] ${result.summary}`);
    if (result.observations.length > 0) {
      console.log('');
      console.log(`Observations written (${result.observations.length}):`);
      for (const obs of result.observations) {
        console.log(`  [${obs.category}] (imp ${obs.importance}) ${obs.subject} — ${obs.title}`);
      }
    }
  }

  if (result.status === 'failed') process.exit(1);
}
