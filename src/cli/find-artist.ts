import { FileConfigStore } from '../lib/config.js';
import { createCliGateway } from '../lib/spotify/gateway.js';
import { secondaryLabel } from '../lib/user-config.js';
import { localUserData, TRUSTED_ARTISTS } from '../lib/user-data/index.js';
import { ArtistLookupService } from '../services/artist-lookup.js';

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
  console.log('Usage: node build/cli/find-artist.js <artist name>');
  process.exit(1);
}

const data = localUserData('.');
const trustedArtists = await data.load(TRUSTED_ARTISTS);
if (!trustedArtists) {
  console.error('trusted-artists.json not found — run recalculate first');
  process.exit(1);
}

const ctx = createCliGateway({ configStore: new FileConfigStore() });
const sl = secondaryLabel(await data.config.load());

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
      `    AW tracks:  ${r.data.allWeekly}  |  ${sl} tracks: ${r.data.bestOfAllWeekly}`,
    );
    console.log(
      `    Recency:    AW +${r.data.recencyBonusAW}  |  ${sl} +${r.data.recencyBonusBoAW}`,
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
