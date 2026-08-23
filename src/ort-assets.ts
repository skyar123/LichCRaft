/**
 * The ONNX Runtime WASM binaries are served from our own origin rather than
 * the jsDelivr default transformers.js would otherwise pick. Hosting them
 * ourselves is what makes the offline and no-third-party-requests promises
 * true: see `ortAssetsPlugin` in vite.config.ts, which copies them in.
 */
export const ORT_ASSET_DIR = 'ort/';

/**
 * Absolute URL of the directory holding the ORT runtime files.
 *
 * Must be called from the main thread: a worker's `location` is its own
 * bundled script under `assets/`, so resolving there yields `assets/ort/`.
 * The result is handed to the worker in the `load` message instead.
 */
export function ortAssetBase(): string {
  return new URL(import.meta.env.BASE_URL + ORT_ASSET_DIR, location.href).href;
}
