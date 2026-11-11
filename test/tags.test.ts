import { describe, expect, it } from 'vitest';
import { defaultTags, resolveTags, sanitizeTag } from '../src/core/tags';

const ctx = (ref?: string, sha = 'ABCDEF1234567890') => ({ ref, sha, isPullRequest: false, tempDir: '/tmp', workspace: '/w' });

describe('tags', () => {
  it('main -> latest + sha', () => expect(defaultTags(ctx('refs/heads/main'))).toEqual(['latest', 'abcdef1']));
  it('feature branch', () => expect(defaultTags(ctx('refs/heads/feature/Foo_bar'))).toEqual(['feature-Foo_bar', 'abcdef1']));
  it('version tag', () => expect(defaultTags(ctx('refs/tags/v1.2.3'))).toEqual(['v1.2.3', '1.2.3', 'abcdef1']));
  it('pull request', () => expect(defaultTags(ctx('refs/pull/42/merge'))).toEqual(['pr-42', 'abcdef1']));
  it('no context -> latest', () => expect(defaultTags({ isPullRequest: false, tempDir: '', workspace: '' })).toEqual(['latest']));
  it('sanitizes', () => expect(sanitizeTag('-.a/b@c')).toBe('a-b-c'));
  it('user tags win', () => expect(resolveTags(['1.0', 'stable', '1.0'], ctx('refs/heads/main'))).toEqual(['1.0', 'stable']));
  it('rejects invalid user tags', () => expect(() => resolveTags(['a/b'], ctx())).toThrow(/Invalid tag/));
});
