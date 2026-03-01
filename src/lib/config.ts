import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfigStore, SpotifyConfig } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
