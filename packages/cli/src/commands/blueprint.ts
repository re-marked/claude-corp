import { listBlueprints, getBlueprint } from '@claudecorp/shared';
import { getCorpRoot } from '../client.js';

export async function cmdBlueprint(opts: {
  action?: string;
  name?: string;
  json: boolean;
}) {
  const corpRoot = await getCorpRoot();
  const action = opts.action ?? 'list';

  if (action === 'list') {
    const blueprints = listBlueprints(corpRoot);

    if (opts.json) {
      console.log(JSON.stringify(blueprints, null, 2));
      return;
    }

    if (blueprints.length === 0) {
      console.log('No blueprints found. Blueprints are installed in blueprints/ on corp creation.');
      return;
    }

    console.log(`BLUEPRINTS (${blueprints.length})\n`);
    for (const bp of blueprints) {
      console.log(`  \u25C6 ${bp.name}`);
      console.log(`    ${bp.description}`);
      console.log(`    ${bp.steps} steps | Roles: ${bp.roles.join(', ')} | Est: ${bp.estimated}`);
      console.log('');
    }
    console.log(`View a blueprint: cc-cli blueprint show --name <name>`);
    return;
  }

  if (action === 'show') {
    const name = opts.name ?? opts.action;
    if (!name || name === 'show') {
      console.error('Usage: cc-cli blueprint show --name <blueprint-name>');
      console.error('Available: ' + listBlueprints(corpRoot).map(b => b.name).join(', '));
      process.exit(1);
    }

    const bp = getBlueprint(corpRoot, name);
    if (!bp) {
      console.error(`Blueprint "${name}" not found.`);
      console.error('Available: ' + listBlueprints(corpRoot).map(b => b.name).join(', '));
      process.exit(1);
    }

    if (opts.json) {
      console.log(JSON.stringify(bp, null, 2));
      return;
    }

    console.log(`BLUEPRINT: ${bp.meta.name}\n`);
    console.log(`  ${bp.meta.description}`);
    console.log(`  ${bp.meta.steps} steps | Roles: ${bp.meta.roles.join(', ')} | Est: ${bp.meta.estimated}`);
    console.log('\n' + '='.repeat(60) + '\n');
    console.log(bp.content);
    return;
  }

  console.error('Usage: cc-cli blueprint [list|show] [--name <name>]');
  process.exit(1);
}
