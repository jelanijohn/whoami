import { describe, it, expect } from 'vitest';
import { buildIdentityProposal, applyIdentityMerge } from './profile-merge';

describe('buildIdentityProposal', () => {
  it('classifies_new_conflict_present', () => {
    const { rows } = buildIdentityProposal(
      { github: 'https://github.com/me', twitter: 'https://twitter.com/me' },
      {
        linkedin: 'https://linkedin.com/in/me', // new
        github: 'https://github.com/someone', // conflict
        twitter: 'https://twitter.com/me' // present
      }
    );
    const byPlatform = Object.fromEntries(rows.map((r) => [r.platform, r]));
    expect(byPlatform.linkedin.status).toBe('new');
    expect(byPlatform.linkedin.existingUrl).toBeUndefined();
    expect(byPlatform.github.status).toBe('conflict');
    expect(byPlatform.github.existingUrl).toBe('https://github.com/me');
    expect(byPlatform.twitter.status).toBe('present');
    expect(byPlatform.twitter.existingUrl).toBe('https://twitter.com/me');
  });

  it('drops_non_http_urls', () => {
    const { rows } = buildIdentityProposal(
      {},
      {
        linkedin: 'https://linkedin.com/in/me',
        evil: 'javascript:alert(1)',
        ftp: 'ftp://example.com/x',
        empty: ''
      }
    );
    expect(rows.map((r) => r.platform)).toEqual(['linkedin']);
  });

  it('same_url_trailing_slash_is_present_not_conflict', () => {
    const { rows } = buildIdentityProposal(
      { github: 'https://github.com/me' },
      { github: 'https://github.com/me/' }
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('present');
  });

  it('row_order_new_then_conflict_then_present', () => {
    const { rows } = buildIdentityProposal(
      {
        github: 'https://github.com/me',
        twitter: 'https://twitter.com/me',
        vimeo: 'https://vimeo.com/me'
      },
      {
        vimeo: 'https://vimeo.com/other', // conflict
        twitter: 'https://twitter.com/me', // present
        github: 'https://github.com/other', // conflict
        linkedin: 'https://linkedin.com/in/me', // new
        instagram: 'https://instagram.com/me' // new
      }
    );
    expect(rows.map((r) => `${r.status}:${r.platform}`)).toEqual([
      'new:instagram',
      'new:linkedin',
      'conflict:github',
      'conflict:vimeo',
      'present:twitter'
    ]);
  });

  it('hasActionable_false_when_all_present', () => {
    const proposal = buildIdentityProposal(
      { github: 'https://github.com/me', twitter: 'https://twitter.com/me' },
      { github: 'https://github.com/me', twitter: 'https://twitter.com/me/' }
    );
    expect(proposal.rows.every((r) => r.status === 'present')).toBe(true);
    expect(proposal.hasActionable).toBe(false);
  });

  it('empty_existing_treats_all_as_new', () => {
    const proposal = buildIdentityProposal(undefined, {
      github: 'https://github.com/me',
      linkedin: 'https://linkedin.com/in/me'
    });
    expect(proposal.rows.every((r) => r.status === 'new')).toBe(true);
    expect(proposal.hasActionable).toBe(true);
  });
});

describe('applyIdentityMerge', () => {
  it('adds_new_keys_preserves_untouched', () => {
    const existing = { github: 'https://github.com/me' };
    const merged = applyIdentityMerge(existing, { linkedin: 'https://linkedin.com/in/me' });
    expect(merged).toEqual({
      github: 'https://github.com/me',
      linkedin: 'https://linkedin.com/in/me'
    });
  });

  it('selected_replaces_conflict', () => {
    const merged = applyIdentityMerge(
      { github: 'https://github.com/me' },
      { github: 'https://github.com/new' }
    );
    expect(merged.github).toBe('https://github.com/new');
  });

  it('never_mutates_input', () => {
    const existing = Object.freeze({ github: 'https://github.com/me' });
    const selected = Object.freeze({ linkedin: 'https://linkedin.com/in/me' });
    const merged = applyIdentityMerge(existing, selected);
    expect(merged).not.toBe(existing);
    expect(merged).not.toBe(selected);
    expect(existing).toEqual({ github: 'https://github.com/me' });
  });

  it('never_deletes_unselected_existing', () => {
    const existing = {
      github: 'https://github.com/me',
      twitter: 'https://twitter.com/me',
      vimeo: 'https://vimeo.com/me'
    };
    const merged = applyIdentityMerge(existing, { linkedin: 'https://linkedin.com/in/me' });
    expect(merged.github).toBe('https://github.com/me');
    expect(merged.twitter).toBe('https://twitter.com/me');
    expect(merged.vimeo).toBe('https://vimeo.com/me');
  });
});
