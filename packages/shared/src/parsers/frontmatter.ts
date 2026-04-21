import matter from 'gray-matter';

export function parse<T>(raw: string): { meta: T; body: string } {
  const result = matter(raw);
  return {
    meta: result.data as T,
    body: result.content.trim(),
  };
}

export function stringify<T extends Record<string, unknown>>(
  meta: T,
  body: string,
): string {
  // js-yaml's safeDump rejects undefined values. Strip top-level undefined
  // keys so optional fields (ttl, updatedBy, etc.) serialize as missing
  // rather than failing. Existing callers (tasks.ts, contracts.ts) set
  // optional fields to explicit null already, so they're unaffected.
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v !== undefined) cleaned[k] = v;
  }
  return matter.stringify(body, cleaned);
}
