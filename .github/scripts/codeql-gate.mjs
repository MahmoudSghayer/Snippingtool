#!/usr/bin/env node
// Gate for .github/workflows/codeql.yml: reads the SARIF that
// `github/codeql-action/analyze` wrote with `upload: never` (this private
// repository has no code scanning to upload to — see docs/11-devops.md),
// prints every finding as a GitHub Actions annotation, and exits 1 when
// any result is error-level. A result's level is its own `level` if set,
// otherwise its rule's `defaultConfiguration.level` (rules live on the
// driver or on tool extensions), otherwise SARIF's default, "warning".
import { readFileSync } from 'node:fs';

const sarifPath = process.argv[2];
if (!sarifPath) {
  console.error('usage: codeql-gate.mjs <results.sarif>');
  process.exit(2);
}

const sarif = JSON.parse(readFileSync(sarifPath, 'utf8'));
let errors = 0;
let warnings = 0;
let notes = 0;

for (const run of sarif.runs ?? []) {
  const driverRules = run.tool?.driver?.rules ?? [];
  const extensions = run.tool?.extensions ?? [];
  const byId = new Map();
  for (const rule of driverRules) byId.set(rule.id, rule);
  for (const ext of extensions) for (const rule of ext.rules ?? []) byId.set(rule.id, rule);

  const resolveRule = (result) => {
    const ref = result.rule;
    if (ref && typeof ref.index === 'number') {
      const pool =
        ref.toolComponent && typeof ref.toolComponent.index === 'number'
          ? (extensions[ref.toolComponent.index]?.rules ?? [])
          : driverRules;
      if (pool[ref.index]) return pool[ref.index];
    }
    if (typeof result.ruleIndex === 'number' && driverRules[result.ruleIndex]) {
      return driverRules[result.ruleIndex];
    }
    return byId.get(result.ruleId) ?? null;
  };

  for (const result of run.results ?? []) {
    const rule = resolveRule(result);
    const level = result.level ?? rule?.defaultConfiguration?.level ?? 'warning';
    const loc = result.locations?.[0]?.physicalLocation;
    const file = loc?.artifactLocation?.uri ?? '';
    const line = loc?.region?.startLine ?? 0;
    const message = (result.message?.text ?? '').replace(/\r?\n/g, ' ');
    const ruleId = result.ruleId ?? rule?.id ?? 'unknown-rule';
    const where = file ? `file=${file},line=${line},` : '';
    if (level === 'error') {
      errors++;
      console.log(`::error ${where}title=CodeQL ${ruleId}::${message}`);
    } else if (level === 'warning') {
      warnings++;
      console.log(`::warning ${where}title=CodeQL ${ruleId}::${message}`);
    } else {
      notes++;
      console.log(`::notice ${where}title=CodeQL ${ruleId}::${message}`);
    }
  }
}

console.log(`CodeQL gate: ${errors} error(s), ${warnings} warning(s), ${notes} note(s)`);
if (errors > 0) {
  console.log('::error::CodeQL reported error-level findings — see the annotations above');
  process.exit(1);
}
