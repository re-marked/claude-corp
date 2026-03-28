import { getClient } from '../client.js';
import { resolveModelAlias, modelDisplayName } from '@claudecorp/shared';

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
    const chain = opts.chain.split(',').map(m => resolveModelAlias(m.trim()) ?? m.trim());
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
