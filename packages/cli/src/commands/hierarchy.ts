import { join } from 'node:path';
import { readConfigOr, buildHierarchy, type Member, type HierarchyNode, MEMBERS_JSON } from '@claudecorp/shared';
import { getCorpRoot } from '../client.js';

export async function cmdHierarchy(opts: { json: boolean }) {
  const corpRoot = await getCorpRoot();
  const members = readConfigOr<Member[]>(join(corpRoot, MEMBERS_JSON), []);
  const tree = buildHierarchy(members);

  if (opts.json) {
    console.log(JSON.stringify(tree, null, 2));
    return;
  }

  if (!tree) {
    console.log('No hierarchy found.');
    return;
  }

  console.log('Corporation Hierarchy:\n');
  function printNode(node: HierarchyNode, indent: number) {
    const pad = '  '.repeat(indent);
    const icon = node.member.type === 'user' ? '\u2605' : '\u25C6';
    console.log(`${pad}${icon} ${node.member.displayName} (${node.member.rank})`);
    for (const child of node.children) {
      printNode(child, indent + 1);
    }
  }
  printNode(tree, 0);
}
