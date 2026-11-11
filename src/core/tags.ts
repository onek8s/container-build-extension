import type { BuildContext } from './platform';

/** Makes a string a valid docker tag: [A-Za-z0-9_][A-Za-z0-9_.-]{0,127} */
export function sanitizeTag(value: string): string {
  let tag = value.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^[.-]+/, '');
  tag = tag.substring(0, 128).replace(/-+$/, '');
  return tag;
}

/**
 * Default tags when the user does not specify any:
 *  - short commit SHA (always, when known)
 *  - git tag name for tag builds (v1.2.3 -> 1.2.3 and v1.2.3)
 *  - `latest` for main/master
 *  - `pr-<n>` for pull requests
 *  - sanitized branch name for other branches
 */
export function defaultTags(ctx: BuildContext): string[] {
  const tags: string[] = [];
  const ref = ctx.ref ?? '';
  let m: RegExpMatchArray | null;
  if ((m = ref.match(/^refs\/tags\/(.+)$/))) {
    const name = sanitizeTag(m[1]);
    tags.push(name);
    if (/^v\d/.test(name)) tags.push(name.substring(1));
  } else if ((m = ref.match(/^refs\/pull\/(\d+)\//))) {
    tags.push(`pr-${m[1]}`);
  } else if ((m = ref.match(/^refs\/heads\/(.+)$/))) {
    const branch = m[1];
    tags.push(branch === 'main' || branch === 'master' ? 'latest' : sanitizeTag(branch));
  }
  if (ctx.sha && /^[0-9a-f]{7,}$/i.test(ctx.sha)) tags.push(ctx.sha.substring(0, 7).toLowerCase());
  if (tags.length === 0) tags.push('latest');
  return [...new Set(tags.filter((t) => t.length > 0))];
}

export function resolveTags(userTags: string[], ctx: BuildContext): string[] {
  const tags = userTags.length > 0 ? userTags.map((t) => {
    const s = sanitizeTag(t);
    if (s !== t) throw new Error(`Invalid tag '${t}'. Tags may contain only [A-Za-z0-9_.-] (max 128 chars).`);
    return s;
  }) : defaultTags(ctx);
  return [...new Set(tags)];
}
