import { describe, expect, it } from 'vitest';
import { harvestIdentities } from './identities';
import type { FetchedPage } from './types';

/** Build a minimal FetchedPage for the harvest (only the fields it reads). */
function page(over: Partial<FetchedPage>): FetchedPage {
  return {
    url: 'https://jane.example/',
    finalUrl: 'https://jane.example/',
    mainText: '',
    structured: { jsonLd: [], openGraph: {}, meta: {} },
    outboundLinks: [],
    ...over
  };
}

describe('harvestIdentities', () => {
  it('maps_known_platform_links', () => {
    const ids = harvestIdentities([
      page({
        outboundLinks: [
          'https://github.com/janeroe',
          'https://www.linkedin.com/in/janeroe',
          'https://twitter.com/janeroe',
          'https://vimeo.com/janeroe',
          'https://janeroe.tumblr.com/',
          'https://www.facebook.com/janeroe',
          'https://jane.example/contact' // not a known platform → ignored
        ]
      })
    ]);
    expect(ids).toEqual({
      github: 'https://github.com/janeroe',
      linkedin: 'https://www.linkedin.com/in/janeroe',
      twitter: 'https://twitter.com/janeroe',
      vimeo: 'https://vimeo.com/janeroe',
      tumblr: 'https://janeroe.tumblr.com/',
      facebook: 'https://www.facebook.com/janeroe'
    });
  });

  it('dedupes_first_occurrence_wins', () => {
    const ids = harvestIdentities([
      page({ outboundLinks: ['https://github.com/janeroe', 'https://github.com/someone-else'] })
    ]);
    expect(ids.github).toBe('https://github.com/janeroe');
  });

  it('reads_jsonld_sameAs', () => {
    const ids = harvestIdentities([
      page({
        structured: {
          jsonLd: [
            {
              '@type': 'Person',
              sameAs: ['https://github.com/janeroe', 'https://x.com/janeroe']
            }
          ],
          openGraph: {},
          meta: {}
        }
      })
    ]);
    expect(ids.github).toBe('https://github.com/janeroe');
    expect(ids.twitter).toBe('https://x.com/janeroe'); // x.com maps to twitter
  });
});
