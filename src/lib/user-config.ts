import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FEATURED_MULTIPLIER } from '../domain/artists.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Types ────────────────────────────────────────────────────────────────────

export interface UserConfig {
  sourcePlaylists: {
    allWeeklyId: string;
    allWeeklyName: string;
    bestOfAllWeeklyId: string;
    bestOfAllWeeklyName: string;
    useLikedSongs: boolean;
  };
  editorialPlaylists: Array<{ id: string; name: string }>;
  externalPlaylistSources: Array<{
    userId: string;
    namePattern: string;
    dateFormat: string;
    label: string;
  }>;
  genreFilters: {
    accepted: string[];
    rejected: string[];
  };
  scoring: {
    awWeight: number;
    boawWeight: number;
    /** Share of credit a featured appearance earns vs a primary one (0.5 = half). */
    featuredMultiplier: number;
    priorityThresholds: { p1: number; p2: number; p3: number; p4: number };
  };
  editorialFilter: {
    minPopularity: number;
    minFollowers: number;
  };
  weeklyListeningBudget: number;
}

// ── Defaults (current hardcoded values) ──────────────────────────────────────

export const DEFAULT_USER_CONFIG: UserConfig = {
  sourcePlaylists: {
    allWeeklyId: '',
    allWeeklyName: '',
    bestOfAllWeeklyId: '',
    bestOfAllWeeklyName: '',
    useLikedSongs: true,
  },
  editorialPlaylists: [],
  externalPlaylistSources: [],
  genreFilters: {
    accepted: [
      'hip-hop',
      'rap',
      'r&b',
      'soul',
      'electronic',
      'house',
      'techno',
      'trap',
      'dancehall',
      'reggaeton',
      'latin',
      'afrobeat',
      'grime',
      'drill',
      'dance',
      'pop',
      'urban',
      'uk',
      'bass',
      'dubstep',
      'garage',
      'funky',
      'afrobeats',
      'reggae',
      'dub',
      'edm',
      'phonk',
    ],
    rejected: [
      'rock',
      'folk',
      'indie folk',
      'classical',
      'post-punk',
      'emo',
      'country',
      'metal',
      'jazz',
      'blues',
    ],
  },
  scoring: {
    awWeight: 2,
    boawWeight: 3,
    featuredMultiplier: DEFAULT_FEATURED_MULTIPLIER,
    priorityThresholds: { p1: 60, p2: 25, p3: 15, p4: 1 },
  },
  editorialFilter: {
    minPopularity: 10,
    minFollowers: 100000,
  },
  weeklyListeningBudget: 15,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Short label for the secondary source playlist. */
export function secondaryLabel(cfg: UserConfig): 'Liked' | 'BoAW' {
  return cfg.sourcePlaylists.useLikedSongs ? 'Liked' : 'BoAW';
}

/** Long-form name for the secondary source playlist. */
export function secondarySourceName(cfg: {
  sourcePlaylists: { useLikedSongs: boolean };
}): string {
  return cfg.sourcePlaylists.useLikedSongs
    ? 'Liked Songs'
    : 'Best of All Weekly';
}

// ── Store interface ─────────────────────────────────────────────────────────

export interface IUserConfigStore {
  exists(): boolean | Promise<boolean>;
  load(): UserConfig | Promise<UserConfig>;
  save(config: UserConfig): void | Promise<void>;
}

/** Merge partial config with defaults so new fields are always present. */
export function mergeConfigWithDefaults(
  partial: Partial<UserConfig>,
): UserConfig {
  const defaults = structuredClone(DEFAULT_USER_CONFIG);
  return {
    sourcePlaylists: {
      ...defaults.sourcePlaylists,
      ...partial.sourcePlaylists,
    },
    editorialPlaylists:
      partial.editorialPlaylists ?? defaults.editorialPlaylists,
    externalPlaylistSources:
      partial.externalPlaylistSources ?? defaults.externalPlaylistSources,
    genreFilters: {
      accepted:
        partial.genreFilters?.accepted ?? defaults.genreFilters.accepted,
      rejected:
        partial.genreFilters?.rejected ?? defaults.genreFilters.rejected,
    },
    scoring: {
      awWeight: partial.scoring?.awWeight ?? defaults.scoring.awWeight,
      boawWeight: partial.scoring?.boawWeight ?? defaults.scoring.boawWeight,
      featuredMultiplier:
        partial.scoring?.featuredMultiplier ??
        defaults.scoring.featuredMultiplier,
      priorityThresholds: {
        ...defaults.scoring.priorityThresholds,
        ...partial.scoring?.priorityThresholds,
      },
    },
    editorialFilter: {
      ...defaults.editorialFilter,
      ...partial.editorialFilter,
    },
    weeklyListeningBudget:
      partial.weeklyListeningBudget ?? defaults.weeklyListeningBudget,
  };
}

// ── File-based store ────────────────────────────────────────���───────────────

export class UserConfigStore implements IUserConfigStore {
  private path: string;

  constructor(configPath?: string) {
    this.path = configPath ?? path.join(__dirname, '../../user-config.json');
  }

  exists(): boolean {
    return fs.existsSync(this.path);
  }

  load(): UserConfig {
    if (!this.exists()) {
      return structuredClone(DEFAULT_USER_CONFIG);
    }
    const raw: Partial<UserConfig> = JSON.parse(
      fs.readFileSync(this.path, 'utf8'),
    );
    return mergeConfigWithDefaults(raw);
  }

  save(config: UserConfig): void {
    fs.writeFileSync(this.path, JSON.stringify(config, null, 2), 'utf8');
  }
}
