/**
 * Path globs used by cache rules and lifecycle scopes.
 *   *   matches any characters except "/"
 *   **  matches any characters including "/"
 *   ?   matches one character except "/"
 * A pattern without a "/" (e.g. "*.css") is matched against the last path segment only.
 */
const cache = new Map<string, RegExp>();

function compile(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

export function globMatch(pattern: string, path: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  let re = cache.get(p);
  if (!re) {
    re = compile(p);
    if (cache.size > 2000) cache.clear();
    cache.set(p, re);
  }
  if (!p.includes('/')) return re.test(path.slice(path.lastIndexOf('/') + 1));
  return re.test(path);
}
