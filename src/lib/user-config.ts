import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Types ────────────────────────────────────────────────────────────────────

export interface UserConfig {
  sourcePlaylists: {
    allWeeklyId: string;
    allWeeklyName: string;
    bestOfAllWeeklyId: string;
    bestOfAllWeeklyName: string;
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
    priorityThresholds: { p1: number; p2: number; p3: number; p4: number };
  };
  editorialFilter: {
    minPopularity: number;
    minFollowers: number;
  };
}

// ── Defaults (current hardcoded values) ──────────────────────────────────────

export const DEFAULT_USER_CONFIG: UserConfig = {
  sourcePlaylists: {
    allWeeklyId: "",
    allWeeklyName: "",
    bestOfAllWeeklyId: "",
    bestOfAllWeeklyName: "",
  },
  editorialPlaylists: [],
  externalPlaylistSources: [],
  genreFilters: {
    accepted: [
      "hip-hop", "rap", "r&b", "soul", "electronic", "house", "techno", "trap",
      "dancehall", "reggaeton", "latin", "afrobeat", "grime", "drill", "dance",
      "pop", "urban", "uk", "bass", "dubstep", "garage", "funky", "afrobeats",
      "reggae", "dub", "edm", "phonk",
    ],
    rejected: [
      "rock", "folk", "indie folk", "classical", "post-punk", "emo", "country",
      "metal", "jazz", "blues",
    ],
  },
  scoring: {
    awWeight: 2,
    boawWeight: 3,
    priorityThresholds: { p1: 60, p2: 25, p3: 15, p4: 1 },
  },
  editorialFilter: {
    minPopularity: 60,
    minFollowers: 100000,
  },
};

// ── Store ────────────────────────────────────────────────────────────────────

export class UserConfigStore {
  private path: string;

  constructor(configPath?: string) {
    this.path = configPath ?? path.join(__dirname, "../../user-config.json");
  }

  exists(): boolean {
    return fs.existsSync(this.path);
  }

  load(): UserConfig {
    if (!this.exists()) {
      return structuredClone(DEFAULT_USER_CONFIG);
    }
    const raw: Partial<UserConfig> = JSON.parse(
      fs.readFileSync(this.path, "utf8"),
    );
    return this.mergeWithDefaults(raw);
  }

  save(config: UserConfig): void {
    fs.writeFileSync(this.path, JSON.stringify(config, null, 2), "utf8");
  }

  /** Merge partial config with defaults so new fields are always present. */
  private mergeWithDefaults(partial: Partial<UserConfig>): UserConfig {
    const defaults = structuredClone(DEFAULT_USER_CONFIG);
    return {
      sourcePlaylists: { ...defaults.sourcePlaylists, ...partial.sourcePlaylists },
      editorialPlaylists: partial.editorialPlaylists ?? defaults.editorialPlaylists,
      externalPlaylistSources: partial.externalPlaylistSources ?? defaults.externalPlaylistSources,
      genreFilters: {
        accepted: partial.genreFilters?.accepted ?? defaults.genreFilters.accepted,
        rejected: partial.genreFilters?.rejected ?? defaults.genreFilters.rejected,
      },
      scoring: {
        awWeight: partial.scoring?.awWeight ?? defaults.scoring.awWeight,
        boawWeight: partial.scoring?.boawWeight ?? defaults.scoring.boawWeight,
        priorityThresholds: {
          ...defaults.scoring.priorityThresholds,
          ...partial.scoring?.priorityThresholds,
        },
      },
      editorialFilter: { ...defaults.editorialFilter, ...partial.editorialFilter },
    };
  }
}
