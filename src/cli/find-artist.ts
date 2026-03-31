import fs from 'node:fs';
import { FileConfigStore } from '../lib/config.js';
import { createSpotifyClient } from '../lib/spotify-client.js';
import { createSpotifyContext } from '../lib/spotify-context.js';
import type { TrustedArtistsFile } from '../lib/types.js';
import { ArtistLookupService } from '../services/artist-lookup.js';

const TRUSTED_ARTISTS_PATH = './trusted-artists.json';

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
  console.log('Usage: node build/cli/find-artist.js <artist name>');
  process.exit(1);
}

const trustedArtists: TrustedArtistsFile = JSON.parse(
  fs.readFileSync(TRUSTED_ARTISTS_PATH, 'utf8'),
);

const configStore = new FileConfigStore();
const client = createSpotifyClient({ configStore });

// Refresh token once up front
await client.refreshToken();

const ctx = createSpotifyContext(client);

const service = new ArtistLookupService(ctx, {
  onResult: (r) => {
    const priorityLabel = r.data.priority ? `P${r.data.priority}` : 'N/A';
    const posStr =
      r.priorityRank !== null
        ? ` — #${r.priorityRank} of ${r.priorityGroupSize}`
        : '';

    console.log(`  ${r.name}`);
    console.log(
      `    Priority:   ${priorityLabel} (score: ${r.data.score})${posStr}`,
    );
    console.log(`    Popularity: ${r.popularity ?? '?'}/100`);
    console.log(`    Followers:  ${r.followers?.toLocaleString() ?? '?'}`);
    console.log(
      `    Genres:     ${r.genres.length ? r.genres.join(', ') : '—'}`,
    );
    console.log(
      `    AW tracks:  ${r.data.allWeekly}  |  BoAW tracks: ${r.data.bestOfAllWeekly}`,
    );
    console.log(
      `    Recency:    AW +${r.data.recencyBonusAW}  |  BoAW +${r.data.recencyBonusBoAW}`,
    );
    console.log(
      `    Spotify:    https://open.spotify.com/artist/${r.data.spotifyId || '?'}`,
    );
    console.log();
  },
  onNotFound: (q) => console.log(`No artists found matching "${q}"`),
});

const results = await service.lookup(query, trustedArtists);
if (results.length > 0) {
  console.log(
    `\nFound ${results.length} match${results.length > 1 ? 'es' : ''} for "${query}":\n`,
  );
}
