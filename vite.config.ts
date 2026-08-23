import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const require_ = createRequire(import.meta.url);

/**
 * transformers.js otherwise points onnxruntime-web at the jsDelivr CDN, which
 * would mean a third-party request on every cold start and no true offline
 * mode. We copy the two runtime variants it can ask for (Safari uses the
 * non-asyncify build) next to the bundle and point `wasmPaths` at them.
 */
const ORT_FILES = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
];

function ortAssetsPlugin(): Plugin {
  // onnxruntime-web does not export ./package.json, so locate its dist
  // directory from the main entry point instead.
  const ortDist = dirname(require_.resolve('onnxruntime-web'));
  return {
    name: 'lichcraft:ort-assets',
    apply: () => true,
    configureServer(server) {
      // Dev server: stream them straight out of node_modules.
      server.middlewares.use((req, res, next) => {
        const name = ORT_FILES.find((f) => req.url?.endsWith('/ort/' + f));
        if (!name) return next();
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        import('node:fs').then(({ createReadStream }) =>
          createReadStream(join(ortDist, name)).pipe(res),
        );
      });
    },
    async writeBundle(options) {
      const outDir = options.dir ?? resolve('dist');
      await mkdir(join(outDir, 'ort'), { recursive: true });
      for (const name of ORT_FILES) {
        await copyFile(join(ortDist, name), join(outDir, 'ort', name));
      }
    },
  };
}

// Cross-origin isolation lets onnxruntime-web use multi-threaded WASM,
// which is a large speedup on the CPU backend. Mirrored in public/_headers
// for production hosting.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  base: './',
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  worker: { format: 'es' },
  resolve: {
    // Picks onnxruntime-web's external-wasm entry, so the binaries come from
    // the `ort/` directory above instead of being inlined into the bundle.
    conditions: ['onnxruntime-web-use-extern-wasm', 'module', 'browser', 'development|production'],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2048,
  },
  plugins: [
    ortAssetsPlugin(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'],
      manifest: {
        name: 'LichCraft — Private Transcription',
        short_name: 'LichCraft',
        description:
          'Free, private speech-to-text. Whisper runs entirely on your device; no audio ever leaves it.',
        theme_color: '#0b0d12',
        background_color: '#0b0d12',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The app shell + the ONNX Runtime wasm binaries are precached so the
        // app boots with no network at all. Model weights are cached separately
        // by transformers.js in the Cache Storage API on first download.
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        globIgnores: ['ort/**'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            // The ONNX Runtime binary this device picked: cached on first use
            // so later launches work with no network.
            urlPattern: ({ url }) => url.pathname.includes('/ort/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'lichcraft-onnxruntime',
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Model weights from the Hugging Face CDN: cache-first and kept
            // forever, so a downloaded model stays available offline.
            urlPattern: /^https:\/\/(huggingface\.co|cdn-lfs[^/]*\.hf\.co)\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'lichcraft-models',
              expiration: { maxEntries: 256, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
              rangeRequests: true,
            },
          },
        ],
      },
    }),
  ],
});
