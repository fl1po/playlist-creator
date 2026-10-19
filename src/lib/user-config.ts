import { DEFAULT_FEATURED_MULTIPLIER } from '../domain/artists.js';

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
  /**
   * Opt-in AI finds. The model, effort, pool cap and cost ceiling are code
   * constants, not config.
   */
  aiFinds: {
    enabled: boolean;
    /** Lowest LLM confidence (0–100) a pick needs to become an AI find. */
    threshold: number;
    scoutingPlaylists: Array<{ id: string; name: string }>;
  };
  /** Listening hours per week; the listening-time view uses it to estimate backlog catch-up. */
  weeklyListeningBudget: number;
  /** Dashboard blocks pinned to the top of the page, by element id. */
  pinnedBlocks: string[];
}

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
  aiFinds: {
    enabled: false,
    threshold: 50,
    scoutingPlaylists: [],
  },
  weeklyListeningBudget: 15,
  pinnedBlocks: ['appHeader'],
};

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
    aiFinds: {
      enabled: partial.aiFinds?.enabled ?? defaults.aiFinds.enabled,
      threshold: clampThreshold(
        partial.aiFinds?.threshold,
        defaults.aiFinds.threshold,
      ),
      scoutingPlaylists:
        partial.aiFinds?.scoutingPlaylists ??
        defaults.aiFinds.scoutingPlaylists,
    },
    weeklyListeningBudget:
      partial.weeklyListeningBudget ?? defaults.weeklyListeningBudget,
    pinnedBlocks: partial.pinnedBlocks ?? defaults.pinnedBlocks,
  };
}

/** A whole number in 0–100, so a typo can't break the fill. */
function clampThreshold(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(100, Math.max(0, Math.round(value)));
}
