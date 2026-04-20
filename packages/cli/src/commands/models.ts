import { getClient } from '../client.js';
import { resolveModelAlias, modelDisplayName, isKnownModel, KNOWN_MODELS } from '@claudecorp/shared';

/**
 * Print a yellow warning if `resolved` isn't a known model. Catches
 * typos ("haiku5", "opuss") at write-time — before they land in
 * config.json and break dispatches silently. Does not block: users may
 * legitimately want to set a brand-new model we haven't added yet.
 */
function warnIfUnknown(raw: string, resolved: string): void {
  if (isKnownModel(resolved)) return;
  const validAliases = KNOWN_MODELS.map(m => m.alias).join(', ');
  console.error(
    `\n⚠  "${raw}" isn't a known alias or model ID — writing it anyway.\n` +
    `   If that wasn't intentional, valid aliases: ${validAliases}\n` +
    `   Full list: cc-cli models (no args)\n`,
  );
}

export async function cmdModels(opts: {
  action?: string;
  agent?: string;
  model?: string;
  chain?: string;
  json: boolean;
}) {
  const client = getClient();

  // Default: show current config
  if (!opts.action || opts.action === 'list') {
    const data = await client.getModels();
    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    console.log(`Corp default: ${modelDisplayName(data.corpDefault.model)} (${data.corpDefault.model})`);
    console.log(`Fallback:     ${data.fallbackChain.length > 0 ? data.fallbackChain.join(' → ') : '(none)'}`);
    console.log('');
    console.log('Agents:');
    for (const a of data.agents) {
      const model = a.model
        ? `${a.model.split('/').pop()} [override]`
        : `${data.corpDefault.model} (default)`;
      console.log(`  ◆ ${a.name.padEnd(22)} ${model}`);
    }
    return;
  }

  // Set default
  if (opts.action === 'default') {
    if (!opts.model) {
      console.error('Usage: claudecorp-cli models default --model <model>');
      process.exit(1);
    }
    const resolved = resolveModelAlias(opts.model) ?? opts.model;
    warnIfUnknown(opts.model, resolved);
    const result = await client.setDefaultModel(resolved);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Corp default changed to ${modelDisplayName(resolved)} (${resolved})`);
    }
    return;
  }

  // Set agent override
  if (opts.action === 'set') {
    if (!opts.agent || !opts.model) {
      console.error('Usage: claudecorp-cli models set --agent <name> --model <model>');
      process.exit(1);
    }
    const resolved = resolveModelAlias(opts.model) ?? opts.model;
    warnIfUnknown(opts.model, resolved);
    const result = await client.setAgentModel(opts.agent, resolved);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`${opts.agent} model set to ${modelDisplayName(resolved)} (${resolved})`);
    }
    return;
  }

  // Clear agent override
  if (opts.action === 'clear') {
    if (!opts.agent) {
      console.error('Usage: claudecorp-cli models clear --agent <name>');
      process.exit(1);
    }
    const result = await client.clearAgentModel(opts.agent);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`${opts.agent} model override cleared (using corp default)`);
    }
    return;
  }

  // Set fallback chain
  if (opts.action === 'fallback') {
    if (!opts.chain) {
      console.error('Usage: claudecorp-cli models fallback --chain "sonnet,haiku"');
      process.exit(1);
    }
    const chain = opts.chain.split(',').map(m => {
      const raw = m.trim();
      const resolved = resolveModelAlias(raw) ?? raw;
      warnIfUnknown(raw, resolved);
      return resolved;
    });
    const result = await client.setFallbackChain(chain);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Fallback chain: ${chain.join(' → ')}`);
    }
    return;
  }

  console.error(`Unknown action: ${opts.action}. Use: list, default, set, clear, fallback`);
  process.exit(1);
}
