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
  return matter.stringify(body, meta);
}
