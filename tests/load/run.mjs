#!/usr/bin/env node
// Orchestrates a full tests/load pass: provisions fixtures (unless
// LOAD_SKIP_PROVISION=1), then runs every scenario under load/scenarios/
// through k6 with the given profile, one after another (never concurrently
// — a load *test*'s own results would otherwise contend with each other for
// the same CPU/network this environment gives k6 itself), writing each
// scenario's JSON summary to load/.artifacts/<profile>-<scenario>.json.
//
// Usage: node load/run.mjs <smoke|soak|stress> [scenario-name ...]
// (no scenario names -> every scenario). See tests/load/README.md.
//
// k6 binary resolution order: $K6_BIN, ./.tools/k6 (repo root — see
// docs/11-devops.md-style "curl a release into .tools/" convention this
// repo already uses for actionlint/hadolint), then `k6` on PATH. If none of
// those exist, falls back to a minimal autocannon-based smoke runner (see
// autocannon-fallback.mjs) that covers the same endpoints with p95/error
// thresholds, at the cost of k6's richer scenario/stages support — good
// enough to still catch a regression when k6 genuinely cannot be installed
// (e.g. no outbound network to GitHub releases), never used silently: it
// prints which mode it's in.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, '..', '..');
const artifactsDir = path.join(dirname, '.artifacts');

const ALL_SCENARIOS = ['auth-login-refresh', 'activity-ingest', 'extension-heartbeat', 'admin-analytics-overview', 'profits-queries'];

const [profile, ...requested] = process.argv.slice(2);
if (!['smoke', 'soak', 'stress'].includes(profile)) {
  console.error('usage: node load/run.mjs <smoke|soak|stress> [scenario-name ...]');
  process.exit(1);
}
const scenarios = requested.length > 0 ? requested : ALL_SCENARIOS;

function resolveK6() {
  if (process.env.K6_BIN && existsSync(process.env.K6_BIN)) return process.env.K6_BIN;
  const local = path.join(repoRoot, '.tools', 'k6');
  if (existsSync(local)) return local;
  const which = spawnSync('k6', ['version'], { stdio: 'ignore' });
  if (which.status === 0) return 'k6';
  return null;
}

async function main() {
  mkdirSync(artifactsDir, { recursive: true });

  if (process.env.LOAD_SKIP_PROVISION !== '1') {
    console.warn('[load/run] provisioning fixtures...');
    execFileSync('node', [path.join(dirname, 'setup', 'provision.mjs')], { stdio: 'inherit', cwd: dirname, env: process.env });
  }

  const k6 = resolveK6();
  const env = { ...process.env, LOAD_PROFILE: profile };

  for (const scenario of scenarios) {
    const scriptPath = path.join(dirname, 'scenarios', `${scenario}.js`);
    if (!existsSync(scriptPath)) {
      console.error(`[load/run] unknown scenario "${scenario}" (no ${path.relative(repoRoot, scriptPath)})`);
      process.exitCode = 1;
      continue;
    }
    const summaryPath = path.join(artifactsDir, `${profile}-${scenario}.json`);
    console.warn(`\n[load/run] === ${scenario} (${profile}) ===`);

    if (k6) {
      const result = spawnSync(k6, ['run', `--summary-export=${summaryPath}`, scriptPath], { stdio: 'inherit', env });
      if (result.status !== 0) process.exitCode = 1;
    } else {
      console.warn('[load/run] k6 not found ($K6_BIN / .tools/k6 / PATH) — falling back to autocannon. See tests/load/README.md "Installing k6".');
      const result = spawnSync('node', [path.join(dirname, 'autocannon-fallback.mjs'), scenario, profile, summaryPath], { stdio: 'inherit', env });
      if (result.status !== 0) process.exitCode = 1;
    }
  }

  console.warn(`\n[load/run] summaries written to ${path.relative(repoRoot, artifactsDir)}/`);
}

await main();
