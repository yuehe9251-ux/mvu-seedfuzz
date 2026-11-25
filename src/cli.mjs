#!/usr/bin/env node
/**
 * mvu-seedfuzz · Universal CLI
 *
 * Commands:
 *   selftest     Verify 100% oracle self-consistency across all operators & combo seeds
 *   list-ops     List indexed variable mutation operators in a preset
 *   gen          Generate a deterministic test case & AI-A story prompt for a seed
 *   check-story  Validate AI-A's story prose and emit AI-B's blind updater prompt
 *   grade        Grade AI-B's <UpdateVariable> output against real oracle truth
 *   report       Aggregate results JSON into a Markdown vulnerability heatmap
 *   run          End-to-end automated fuzzing via OpenAI-compatible or Gemini REST API
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import {
  mulberry32,
  applyMvuPatches,
  generateCase,
  verifyGeneratedStory,
  buildBlindUpdaterPrompt,
  gradeUpdaterOutput,
  buildHeatmapReport,
} from './engine.mjs';
import { callLLM } from './providers.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) args[k] = true;
      else { args[k] = next; i++; }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function parseSeedList(spec) {
  const out = [];
  for (const part of String(spec || '1001..1006').split(',')) {
    const t = part.trim();
    if (!t) continue;
    const m = t.match(/^(\d+)\.\.(\d+)$/);
    if (m) {
      const a = Number(m[1]), b = Number(m[2]);
      for (let s = Math.min(a, b); s <= Math.max(a, b); s++) out.push(s);
    } else if (/^\d+$/.test(t)) {
      out.push(Number(t));
    }
  }
  return out;
}

async function loadPreset(presetPath) {
  const resolved = path.resolve(presetPath || 'presets/minimal-rpg.mjs');
  const mod = await import(pathToFileURL(resolved).href);
  const preset = mod.default || mod.preset;
  if (!preset || !Array.isArray(preset.operators)) {
    throw new Error(`Invalid preset module: ${resolved} (expected default export with operators[])`);
  }
  return preset;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || 'help';

if (cmd === 'help' || args.help) {
  console.log(`mvu-seedfuzz — Seed-Driven Reverse-Oracle Variable Fuzzer for AI RP / SillyTavern MVU

Usage:
  mvu-seedfuzz selftest     [--preset presets/minimal-rpg.mjs]
  mvu-seedfuzz list-ops     [--preset presets/minimal-rpg.mjs]
  mvu-seedfuzz gen          --seed 1001 --k 4 [--preset ...] [--out case.json]
  mvu-seedfuzz check-story  --seed 1001 --k 4 --story-file s.txt [--context-chars 55000] [--prompt-out p.txt] [--preset ...]
  mvu-seedfuzz grade        --seed 1001 --k 4 --output-file out.txt [--preset ...]
  mvu-seedfuzz report       --results-file results.json [--md-out heatmap.md]
  mvu-seedfuzz run          --seeds 1001..1010 [--long-seeds 1008..1010 --context-chars 55000] --k 4 --api-url <url> --api-key <key> --model <name> [--preset ...] [--concurrency 3] [--md-out heatmap.md]
`);
  process.exit(0);
}

const preset = cmd === 'report' ? null : await loadPreset(args.preset);

if (cmd === 'selftest') {
  const base = typeof preset.runOracle === 'function' ? preset.runOracle(preset.createBaseState(), 1) : preset.createBaseState();
  let singlePass = 0;
  const failures = [];
  for (let i = 0; i < preset.operators.length; i++) {
    const op = preset.operators[i];
    const built = op.build(mulberry32(9000 + i), base);
    const applied = applyMvuPatches(base, built.expectedPatches);
    const after = typeof preset.runOracle === 'function' ? preset.runOracle(applied.statData, 2) : applied.statData;
    const v = built.verify(after, after, base);
    if (v.ok && applied.errors.length === 0) singlePass++;
    else failures.push({ id: op.id, errors: applied.errors, detail: v.detail });
  }
  const k = Math.min(4, preset.operators.length);
  let comboPass = 0;
  for (let seed = 1001; seed <= 1010; seed++) {
    const tc = generateCase(preset, seed, { k });
    const perfectOut = `<UpdateVariable><JSONPatch>${JSON.stringify(tc.expectedPatches)}</JSONPatch></UpdateVariable>`;
    const g = gradeUpdaterOutput(preset, tc, perfectOut);
    if (g.allPassed) comboPass++;
    else failures.push({ seed, drift: g.driftWarnings, failed: g.opResults.filter((x) => !x.ok) });
  }
  const ok = singlePass === preset.operators.length && comboPass === 10;
  console.log(JSON.stringify({ preset: preset.name, totalOperators: preset.operators.length, singleOpPassed: singlePass, comboSeedsPassed: `${comboPass}/10`, ok, failures }, null, 2));
  process.exit(ok ? 0 : 1);
}

if (cmd === 'list-ops') {
  console.log(JSON.stringify(preset.operators.map((o, i) => ({ index: i, id: o.id, domain: o.domain, name: o.name, conflicts: o.conflicts || [] })), null, 2));
  process.exit(0);
}

if (cmd === 'gen') {
  const tc = generateCase(preset, Number(args.seed || 1001), { k: Number(args.k || 4) });
  const payload = {
    presetName: tc.presetName,
    seed: tc.seed,
    k: tc.k,
    vectorIndices: tc.vectorIndices,
    picked: tc.picked.map((p) => ({ opIndex: p.opIndex, id: p.id, domain: p.domain, name: p.name, storyFact: p.storyFact, requiredTokens: p.requiredTokens })),
    storyPrompt: tc.storyPrompt,
  };
  const json = JSON.stringify(payload, null, 2);
  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, json, 'utf8');
  } else console.log(json);
  process.exit(0);
}

if (cmd === 'check-story') {
  const story = fs.readFileSync(args['story-file'], 'utf8');
  const tc = generateCase(preset, Number(args.seed || 1001), { k: Number(args.k || 4) });
  const chk = verifyGeneratedStory(tc, story);
  const contextChars = Math.max(0, Number(args['context-chars'] || 0));
  if (args['prompt-out']) {
    fs.mkdirSync(path.dirname(path.resolve(args['prompt-out'])), { recursive: true });
    const promptTxt = buildBlindUpdaterPrompt(preset, tc, story, { ...args, contextChars });
    fs.writeFileSync(args['prompt-out'], promptTxt, 'utf8');
    chk.blindPromptChars = promptTxt.length;
  }
  console.log(JSON.stringify(chk, null, 2));
  process.exit(0);
}

if (cmd === 'grade') {
  const rawOut = fs.readFileSync(args['output-file'], 'utf8');
  const tc = generateCase(preset, Number(args.seed || 1001), { k: Number(args.k || 4) });
  console.log(JSON.stringify(gradeUpdaterOutput(preset, tc, rawOut), null, 2));
  process.exit(0);
}

if (cmd === 'report') {
  const results = JSON.parse(fs.readFileSync(args['results-file'], 'utf8'));
  const rep = buildHeatmapReport(results, { model: args.model });
  if (args['md-out']) {
    fs.mkdirSync(path.dirname(path.resolve(args['md-out'])), { recursive: true });
    fs.writeFileSync(args['md-out'], rep.markdown, 'utf8');
  }
  console.log(rep.markdown);
  process.exit(0);
}

if (cmd === 'run') {
  const seeds = parseSeedList(args.seeds || '1001..1006');
  const longSeedSet = new Set(args['long-seeds'] ? parseSeedList(args['long-seeds']) : []);
  const defaultContextChars = Math.max(0, Number(args['context-chars'] || 0));
  const k = Number(args.k || 4);
  const concurrency = Math.max(1, Math.min(12, Number(args.concurrency || 3)));
  const apiUrl = args['api-url'] || process.env.FUZZ_API_URL;
  const apiKey = args['api-key'] || process.env.FUZZ_API_KEY || '';
  const model = args.model || process.env.FUZZ_MODEL;
  const storyUrl = args['story-api-url'] || apiUrl;
  const storyKey = args['story-api-key'] || apiKey;
  const storyModel = args['story-model'] || model;
  if (!apiUrl) {
    console.error('Error: --api-url (or env FUZZ_API_URL) is required for `run`.');
    process.exit(2);
  }

  const results = new Array(seeds.length);
  let cursor = 0;
  async function worker() {
    while (cursor < seeds.length) {
      const idx = cursor++;
      const seed = seeds[idx];
      const tc = generateCase(preset, seed, { k });
      let story = await callLLM({ apiUrl: storyUrl, apiKey: storyKey, model: storyModel, prompt: tc.storyPrompt, temperature: 0.4 });
      let chk = verifyGeneratedStory(tc, story);
      if (!chk.ok) {
        const retryPrompt = `${tc.storyPrompt}\n\n[RETRY: previous draft failed check] missing=${JSON.stringify(chk.missing)}, hasLeakTag=${chk.hasLeakTag}. Rewrite pure story prose only.`;
        story = await callLLM({ apiUrl: storyUrl, apiKey: storyKey, model: storyModel, prompt: retryPrompt, temperature: 0.25 });
        chk = verifyGeneratedStory(tc, story);
      }
      const seedCtxChars = longSeedSet.size > 0
        ? (longSeedSet.has(seed) ? (defaultContextChars || 55000) : 0)
        : defaultContextChars;
      const blindPrompt = buildBlindUpdaterPrompt(preset, tc, story, { ...args, contextChars: seedCtxChars });
      const updOut = await callLLM({ apiUrl, apiKey, model, prompt: blindPrompt, temperature: 0.1 });
      const g = gradeUpdaterOutput(preset, tc, updOut);
      g.storyValid = chk.ok;
      g.isLongContext = seedCtxChars > 0;
      g.promptChars = blindPrompt.length;
      results[idx] = g;
      const modeTag = g.isLongContext ? `LONG(${g.promptChars}c)` : `STD(${g.promptChars}c)`;
      console.log(`[SEED ${seed}] [${modeTag}] storyOk=${chk.ok} passed=${g.passedOps}/${g.totalOps} drift=${g.driftWarnings.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, seeds.length) }, () => worker()));

  const rep = buildHeatmapReport(results, { model: model || 'custom-endpoint' });
  if (args['json-out']) {
    fs.mkdirSync(path.dirname(path.resolve(args['json-out'])), { recursive: true });
    fs.writeFileSync(args['json-out'], JSON.stringify(results, null, 2), 'utf8');
  }
  if (args['md-out']) {
    fs.mkdirSync(path.dirname(path.resolve(args['md-out'])), { recursive: true });
    fs.writeFileSync(args['md-out'], rep.markdown, 'utf8');
  }
  console.log('\n' + rep.markdown);
  process.exit(0);
}

console.error('Unknown command:', cmd);
process.exit(2);
