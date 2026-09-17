// engine/adapters/profile.ts — read-only ProfileStore + config loading.
// profile/ is the frozen anchor: this adapter has NO write methods (enforced by
// the port, not by convention).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { Config, ProfileBundle } from "../domain/types.ts";
import type { ProfileStore } from "../ports.ts";
import { validateConfig } from "../domain/config.ts";
import { checkProfile, factVaultFiles, firstMatching, POSITIONING_SUFFIX } from "../domain/profile.ts";

export class ConfigError extends Error {}

export function loadConfig(root: string): Config {
  const file = join(root, "config.yml");
  if (!existsSync(file)) throw new ConfigError(`config.yml not found at ${file}`);
  let raw: unknown;
  try { raw = YAML.parse(readFileSync(file, "utf-8")); }
  catch (e) { throw new ConfigError(`config.yml is not valid YAML: ${(e as Error).message}`); }
  const { config, problems } = validateConfig(raw);
  if (problems.length > 0) {
    throw new ConfigError(`config.yml failed validation:\n  - ${problems.join("\n  - ")}`);
  }
  return config;
}

export function createProfileStore(profileDir: string): ProfileStore {
  const list = (): string[] => existsSync(profileDir) ? readdirSync(profileDir) : [];
  return {
    load(): ProfileBundle {
      const files = list();
      const posFile = firstMatching(files, POSITIONING_SUFFIX);
      const vaultFile = factVaultFiles(files)[0];
      const read = (f?: string) => (f && existsSync(join(profileDir, f)) ? readFileSync(join(profileDir, f), "utf-8") : "");
      return {
        positioning: read(posFile),
        masterResume: read("resume.yml"),
        factVault: read(vaultFile),
      };
    },
  };
}

export function gateProfile(profileDir: string): { ok: boolean; missing: string[] } {
  return checkProfile(existsSync(profileDir) ? readdirSync(profileDir) : []);
}

/** Prompt files are versioned product — read through one seam so tests can stub. */
export function createPromptReader(promptsDir: string) {
  return {
    read(name: string): string {
      const f = join(promptsDir, name);
      if (!existsSync(f)) throw new Error(`prompt file missing: ${f}`);
      return readFileSync(f, "utf-8");
    },
  };
}
