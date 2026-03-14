import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateId } from '../id.js';

export function readConfig<T>(
  filePath: string,
  validate?: (raw: unknown) => T,
): T {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  return validate ? validate(parsed) : (parsed as T);
}

export function readConfigOr<T>(
  filePath: string,
  fallback: T,
  validate?: (raw: unknown) => T,
): T {
  if (!existsSync(filePath)) return fallback;
  return readConfig(filePath, validate);
}

export function writeConfig<T>(filePath: string, data: T): void {
  const json = JSON.stringify(data, null, 2) + '\n';
  const tmpPath = join(dirname(filePath), `.tmp-${generateId()}.json`);
  writeFileSync(tmpPath, json, 'utf-8');
  renameSync(tmpPath, filePath);
}
