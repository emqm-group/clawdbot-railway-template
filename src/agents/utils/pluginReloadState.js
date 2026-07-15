/**
 * Plugin-reload version tracking — bridges tool registration and the gateway
 * restart path so that a genuine tools-manifest change forces a FULL gateway
 * respawn (the only thing that rebuilds openclaw's per-process plugin registry),
 * while every other restart keeps the cheap in-process SIGUSR1 restart.
 *
 * WHY: openclaw caches its plugin registry per-process, keyed on the plugins
 * config and NOT on tools-manifest.json (src/plugins/loader.ts `registryCache`).
 * Our `third-party-tools` plugin builds its tool set by reading that manifest at
 * plugin-load, so a manifest change only takes effect when a fresh process boots
 * and re-reads it. An in-process restart returns the stale boot-time registry.
 *
 * MODEL: two monotonic counters in this (the wrapper) process.
 *  - `manifestVersion` — bumped every time the manifest ACTUALLY changes.
 *  - `loadedVersion`   — the manifest version the currently-running gateway
 *                        process read at its boot.
 * A reload is owed exactly when `manifestVersion > loadedVersion`.
 *
 * Why a version and not a boolean: a manifest write that lands DURING a respawn
 * bumps `manifestVersion` past the version that respawn captured, so the reload
 * stays owed and the next restart respawns again. A boolean cleared on success
 * would silently drop that concurrent change (the lost-update race).
 */

let manifestVersion = 0;
let loadedVersion = 0;

/** Record that the tools manifest actually changed. Call ONLY on a real change. */
export function bumpManifestVersion() {
  manifestVersion += 1;
}

/**
 * The current manifest version. Capture this BEFORE a gateway boot begins, then
 * pass it to markPluginRegistryLoaded() once the fresh process is serving.
 */
export function currentManifestVersion() {
  return manifestVersion;
}

/**
 * True when the running gateway hasn't loaded the latest manifest — i.e. a
 * manifest change happened after the current process booted, so it needs a full
 * respawn (an in-process restart would reuse the cached registry).
 */
export function isPluginReloadPending() {
  return manifestVersion > loadedVersion;
}

/**
 * Record that a freshly-booted gateway process loaded the manifest up to
 * `version`. Pass the version captured BEFORE the boot began: the process may
 * have read a newer file, but crediting only the captured version is the safe
 * lower bound — a write that landed mid-boot stays owed rather than being
 * silently marked loaded. Monotonic (never regresses `loadedVersion`).
 */
export function markPluginRegistryLoaded(version) {
  if (version > loadedVersion) loadedVersion = version;
}
