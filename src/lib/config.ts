import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig, ConfigStore, SpotifyConfig, UserTokens } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "../..");

export class FileConfigStore implements ConfigStore {
  private path: string;

  constructor(configPath?: string) {
    this.path =
      configPath ?? path.join(__dirname, "../../spotify-config.json");
  }

  load(): SpotifyConfig {
    if (!fs.existsSync(this.path)) {
      throw new Error(
        `Spotify configuration file not found at ${this.path}. Please create one with clientId, clientSecret, and redirectUri.`,
      );
    }

    const config: SpotifyConfig = JSON.parse(
      fs.readFileSync(this.path, "utf8"),
    );

    if (!(config.clientId && config.clientSecret && config.redirectUri)) {
      throw new Error(
        "Spotify configuration must include clientId, clientSecret, and redirectUri.",
      );
    }

    return config;
  }

  save(config: SpotifyConfig): void {
    fs.writeFileSync(this.path, JSON.stringify(config, null, 2), "utf8");
  }
}

/** Default singleton for scripts that only need one config file. */
export function createFileConfigStore(configPath?: string): FileConfigStore {
  return new FileConfigStore(configPath);
}

// ── App Config Store (shared credentials) ──────────────────────────────────

export class AppConfigStore {
  private path: string;

  constructor(configPath?: string) {
    this.path = configPath ?? path.join(PROJECT_ROOT, "data/app-config.json");
  }

  load(): AppConfig {
    if (!fs.existsSync(this.path)) {
      throw new Error(
        `App config not found at ${this.path}. Create data/app-config.json with clientId, clientSecret, and redirectUri.`,
      );
    }
    const config: AppConfig = JSON.parse(fs.readFileSync(this.path, "utf8"));
    if (!(config.clientId && config.clientSecret && config.redirectUri)) {
      throw new Error(
        "App config must include clientId, clientSecret, and redirectUri.",
      );
    }
    return config;
  }

  exists(): boolean {
    return fs.existsSync(this.path);
  }

  save(config: AppConfig): void {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.writeFileSync(this.path, JSON.stringify(config, null, 2), "utf8");
  }
}

// ── User Token Store (per-user OAuth tokens) ───────────────────────────────

export class UserTokenStore {
  private path: string;

  constructor(userId: string, dataDir?: string) {
    const base = dataDir ?? path.join(PROJECT_ROOT, "data/users", userId);
    this.path = path.join(base, "tokens.json");
  }

  load(): UserTokens | null {
    if (!fs.existsSync(this.path)) return null;
    return JSON.parse(fs.readFileSync(this.path, "utf8"));
  }

  save(tokens: UserTokens): void {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.writeFileSync(this.path, JSON.stringify(tokens, null, 2), "utf8");
  }
}

/**
 * Bridges AppConfig + UserTokenStore into a ConfigStore that existing
 * SpotifyClient code expects. Token reads/writes go to the user's dir;
 * app credentials come from AppConfig.
 */
export class BridgedConfigStore implements ConfigStore {
  constructor(
    private appConfig: AppConfig,
    private tokenStore: UserTokenStore,
  ) {}

  load(): SpotifyConfig {
    const tokens = this.tokenStore.load();
    return {
      ...this.appConfig,
      accessToken: tokens?.accessToken,
      refreshToken: tokens?.refreshToken,
    };
  }

  save(config: SpotifyConfig): void {
    if (config.accessToken && config.refreshToken) {
      this.tokenStore.save({
        accessToken: config.accessToken,
        refreshToken: config.refreshToken,
      });
    }
  }
}
