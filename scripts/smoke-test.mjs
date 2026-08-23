/**
 * End-to-end smoke test: builds are useless if the model never actually
 * transcribes. This boots the production build in a real browser, loads the
 * smallest Whisper model, feeds it a known clip, and checks the words come
 * back. Run with: npm run test:e2e
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT ?? 4319);
const ORIGIN = `http://localhost:${PORT}`;
const FIXTURE_DIR = join(process.cwd(), '.fixtures');
const FIXTURE = join(FIXTURE_DIR, 'jfk.wav');
const MODEL_DIR = join(FIXTURE_DIR, 'model');
const CLIP_URL =
  'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav';

// The test serves the model from disk rather than the network. That keeps the
// run hermetic and repeatable, and it means a CI box behind a restrictive
// egress proxy still exercises the whole pipeline: decode, ONNX Runtime, and
// Whisper itself. Downloading from Hugging Face is the one step it skips.
const MODEL_REPO = 'Xenova/whisper-tiny.en';
const MODEL_FILES = [
  'config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'generation_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];
// The clip is JFK's inaugural address; these words must survive transcription.
const EXPECTED = ['fellow', 'americans', 'country'];

async function ensureFixture() {
  try {
    await access(FIXTURE);
    return;
  } catch {
    /* not cached yet */
  }
  console.log('· downloading test clip');
  const res = await fetch(CLIP_URL);
  if (!res.ok) throw new Error(`Could not fetch test clip: ${res.status}`);
  await mkdir(FIXTURE_DIR, { recursive: true });
  await writeFile(FIXTURE, Buffer.from(await res.arrayBuffer()));
}

function startPreview() {
  const proc = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('preview server did not start')), 30_000);
    const onData = (buf) => {
      if (buf.toString().includes(String(PORT))) {
        clearTimeout(timer);
        resolve(proc);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
  });
}

async function ensureModelFixture() {
  await mkdir(join(MODEL_DIR, 'onnx'), { recursive: true });
  for (const name of MODEL_FILES) {
    const target = join(MODEL_DIR, name);
    try {
      await access(target);
      continue;
    } catch {
      /* not cached yet */
    }
    console.log(`· downloading ${name}`);
    const res = await fetch(`https://huggingface.co/${MODEL_REPO}/resolve/main/${name}`);
    if (!res.ok) throw new Error(`Could not fetch ${name}: ${res.status}`);
    await writeFile(target, Buffer.from(await res.arrayBuffer()));
  }
}

/**
 * Serve any huggingface.co request for this model out of MODEL_DIR. Routing is
 * installed on the browser context, not the page: the model is fetched from
 * inside a Web Worker, whose requests page-level routing does not see.
 */
async function serveModelLocally(page, onRequest) {
  await page.context().route('https://huggingface.co/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    onRequest(path);
    const match = MODEL_FILES.find((name) => path.endsWith(`/${name}`));
    if (!match) return route.fulfill({ status: 404, body: 'not a fixture' });
    const body = await readFile(join(MODEL_DIR, match));
    await route.fulfill({
      status: 200,
      contentType: match.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body,
    });
  });
}

/**
 * Waits for a status element to satisfy `done`, but gives up immediately if the
 * app puts something in its error banner — otherwise a failure just looks like
 * a timeout, which says nothing about the cause.
 */
async function waitForStatusOrError(page, selector, done, timeout, what) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const [status, error] = await Promise.all([
      page.textContent(selector),
      page.textContent('#error'),
    ]);
    if (error?.trim()) throw new Error(`app reported an error during ${what}: ${error.trim()}`);
    if (status && done(status.trim())) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what} (last status: "${status?.trim()}")`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function main() {
  await ensureFixture();
  await ensureModelFixture();
  const server = await startPreview();
  // Honour a pre-provisioned Chromium (CI images often pin one that does not
  // match the npm package's expected build number).
  const executablePath = process.env.CHROMIUM_PATH || undefined;

  // Sandboxed CI containers often route all egress through a local MITM proxy.
  // Chromium does not read the *_PROXY variables, so pass them through, and
  // accept the proxy's own certificate — this affects only the throwaway
  // browser this test launches.
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch({
    executablePath,
    proxy: proxyUrl ? { server: proxyUrl, bypass: 'localhost,127.0.0.1' } : undefined,
    args: [
      '--enable-features=SharedArrayBuffer',
      ...(proxyUrl ? ['--ignore-certificate-errors'] : []),
    ],
  });
  let failure = null;

  try {
    const page = await browser.newPage();
    const externalHosts = new Set();
    page.on('request', (req) => {
      const host = new URL(req.url()).host;
      if (host !== `localhost:${PORT}`) externalHosts.add(host);
    });
    const servedFromFixture = [];
    await serveModelLocally(page, (path) => servedFromFixture.push(path));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log('  [browser error]', msg.text());
    });

    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });

    console.log('· loading tiny.en');
    await page.selectOption('#modelSelect', 'tiny.en');
    await page.click('#loadBtn');
    await waitForStatusOrError(
      page,
      '#loadStatus',
      (text) => text.includes('ready'),
      120_000,
      'model load',
    );

    console.log('· decoding audio (stereo 44.1kHz -> mono 16kHz)');
    await page.setInputFiles('#fileInput', FIXTURE);
    await page.waitForSelector('#audioSummary:not([hidden])', { timeout: 30_000 });
    const summary = await page.textContent('#audioSummaryText');
    console.log(`  ${summary?.trim()}`);

    console.log('· transcribing');
    await page.click('#runBtn');
    await waitForStatusOrError(
      page,
      '#runStatus',
      (text) => text === 'Done.',
      300_000,
      'transcription',
    );

    const text = (await page.inputValue('#output')).toLowerCase();
    const meta = await page.textContent('#outputMeta');
    console.log(`  transcript: ${text.trim()}`);
    console.log(`  ${meta?.trim()}`);

    const missing = EXPECTED.filter((word) => !text.includes(word));
    if (missing.length) throw new Error(`transcript missing expected words: ${missing.join(', ')}`);

    // Exporting is the other half of the promise, so drive a real download
    // and check the bytes are actually shaped like SRT.
    console.log('· exporting SRT');
    await page.selectOption('#formatSelect', 'srt');
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      page.click('#downloadBtn'),
    ]);
    const srtPath = join(FIXTURE_DIR, 'out.srt');
    await download.saveAs(srtPath);
    const srt = await readFile(srtPath, 'utf8');
    if (!/^1\r?\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\r?\n\S/.test(srt)) {
      throw new Error(`SRT export is malformed:\n${srt.slice(0, 200)}`);
    }
    console.log(`  ${srt.split('\n')[1]}`);

    // Privacy claim: the only host reached beyond our own origin should be
    // Hugging Face, for the one-time model download.
    const unexpected = [...externalHosts].filter(
      (host) => !/(^|\.)huggingface\.co$|(^|\.)hf\.co$/.test(host),
    );
    console.log(`· model files served from fixtures: ${servedFromFixture.length}`);
    console.log(`· external hosts contacted: ${[...externalHosts].join(', ') || 'none'}`);
    if (unexpected.length) {
      throw new Error(`unexpected third-party requests: ${unexpected.join(', ')}`);
    }

    console.log('\n✓ smoke test passed');
  } catch (err) {
    failure = err;
  } finally {
    await browser.close();
    server.kill();
  }

  if (failure) {
    console.error(`\n✗ ${failure.message}`);
    process.exit(1);
  }
}

main();
