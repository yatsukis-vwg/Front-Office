#!/usr/bin/env tsx
/**
 * Validates every clinic knowledge base file.
 *
 * Run this after any edit to clinics/*.yaml — it is the gate that stops a
 * malformed onboarding file from reaching the agent.
 *
 *   npm run kb:validate            # all clinics
 *   npm run kb:validate -- slug    # one clinic
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { clinicFilePath, listClinicSlugs } from '../packages/core/src/kb/loader.js';
import { validateKnowledgeBase } from '../packages/core/src/kb/schema.js';

const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const slugs = requested.length > 0 ? requested : listClinicSlugs();

if (slugs.length === 0) {
  console.error('No clinic files found in clinics/');
  process.exit(1);
}

let failures = 0;

for (const slug of slugs) {
  const path = clinicFilePath(slug);
  let parsed: unknown;
  try {
    const raw = readFileSync(path, 'utf8');
    parsed = path.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw);
  } catch (error) {
    failures++;
    console.error(`✗ ${slug}: could not read/parse ${path}\n  ${(error as Error).message}`);
    continue;
  }

  const result = validateKnowledgeBase(parsed);
  if (!result.ok) {
    failures++;
    console.error(`✗ ${slug} (${path})`);
    for (const issue of result.issues) console.error(`    ${issue.path || '(root)'}: ${issue.message}`);
    continue;
  }

  const kb = result.kb;
  const priced = kb.services.filter((s) => s.price).length;
  console.log(
    `✓ ${slug} — ${kb.services.length} services (${priced} priced), ${kb.doctors.length} doctors, ` +
      `${kb.faqs.length} FAQs, ${kb.insurance.accepted.length} insurers, ` +
      `${kb.instructions.pre.length + kb.instructions.post.length} instruction sets`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} clinic file(s) failed validation.`);
  process.exit(1);
}
console.log('\nAll clinic knowledge bases are valid.');
