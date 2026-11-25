/**
 * mvu-seedfuzz · Zero-cost deterministic unit & self-check test suite
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import minimalPreset from '../presets/minimal-rpg.mjs';
import {
  mulberry32,
  applyMvuPatches,
  extractPatchesFromOutput,
  generateCase,
  verifyGeneratedStory,
  buildRealisticHistoryFiller,
  buildBlindUpdaterPrompt,
  gradeUpdaterOutput,
  buildHeatmapReport,
  buildCompareReport,
} from '../src/engine.mjs';

const execFileAsync = promisify(execFile);

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('Running mvu-seedfuzz self-check...');

test('mulberry32 determinism', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 10; i++) assert.equal(a(), b());
});

test('all 12 minimal-rpg operators pass single-op oracle check', () => {
  const base = minimalPreset.runOracle(minimalPreset.createBaseState(), 1);
  for (let i = 0; i < minimalPreset.operators.length; i++) {
    const op = minimalPreset.operators[i];
    const built = op.build(mulberry32(500 + i), base);
    const applied = applyMvuPatches(base, built.expectedPatches);
    assert.equal(applied.errors.length, 0, `${op.id} patch errors: ${applied.errors}`);
    const after = minimalPreset.runOracle(applied.statData, 2);
    const v = built.verify(after, after, base);
    assert.equal(v.ok, true, `${op.id} failed: ${v.detail}`);
  }
});

test('10 deterministic combo seeds (k=4) grade 100% with zero drift', () => {
  const results = [];
  for (let seed = 1001; seed <= 1010; seed++) {
    const tc1 = generateCase(minimalPreset, seed, { k: 4 });
    const tc2 = generateCase(minimalPreset, seed, { k: 4 });
    assert.deepEqual(tc1.vectorIndices, tc2.vectorIndices);
    const perfect = `<UpdateVariable><JSONPatch>${JSON.stringify(tc1.expectedPatches)}</JSONPatch></UpdateVariable>`;
    const g = gradeUpdaterOutput(minimalPreset, tc1, perfect);
    assert.equal(g.allPassed, true, `seed=${seed} failed: ${JSON.stringify(g)}`);
    assert.equal(g.driftWarnings.length, 0);
    results.push(g);
  }
  const rep = buildHeatmapReport(results, { model: 'oracle-self' });
  assert.equal(rep.summary.hitRatePct, 100);
  assert.ok(rep.markdown.includes('MVU-SeedFuzz Variable Vulnerability Heatmap'));
});

test('story gate catches missing tokens and leaked XML/JSON tags', () => {
  const tc = generateCase(minimalPreset, 1001, { k: 3 });
  const badLeak = 'Aria walked into town <UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>';
  const chk1 = verifyGeneratedStory(tc, badLeak);
  assert.equal(chk1.ok, false);
  assert.equal(chk1.hasLeakTag, true);

  const syntheticGood = tc.picked.map((p) => p.storyFact).join(' ') + ' '.padEnd(80, '.');
  const chk2 = verifyGeneratedStory(tc, syntheticGood);
  assert.equal(chk2.ok, true);

  const blindPrompt = buildBlindUpdaterPrompt(minimalPreset, tc, syntheticGood);
  assert.ok(!blindPrompt.includes('expectedPatches'));
  assert.ok(blindPrompt.includes('CURRENT stat_data'));
});

test('drift detector catches catastrophic parent-container overwrite', () => {
  const tc = generateCase(minimalPreset, 1002, { k: 2 });
  const badPatch = `<UpdateVariable><JSONPatch>[{"op":"replace","path":"/companions","value":{}}]</JSONPatch></UpdateVariable>`;
  const g = gradeUpdaterOutput(minimalPreset, tc, badPatch);
  assert.equal(g.allPassed, false);
  assert.ok(g.driftWarnings.some((w) => w.includes('npc_lyra')));
});

test('extractPatchesFromOutput parses fenced JSON and trailing commas', () => {
  const raw = '```json\n[{"op":"delta","path":"/player/hp","value":-10},]\n```';
  const res = extractPatchesFromOutput(raw);
  assert.equal(res.ok, true);
  assert.equal(res.patches.length, 1);
  assert.equal(res.patches[0].value, -10);
});

test('custom parseModelOutput + applyUpdate hooks support non-JSONPatch frameworks', () => {
  const customPreset = {
    ...minimalPreset,
    operators: [minimalPreset.operators[0]], // player_hp_damage
    parseModelOutput(raw) {
      const m = String(raw).match(/HP_DELTA=([+-]?\d+)/);
      return m ? { ok: true, patches: [{ hpDelta: Number(m[1]) }], error: null } : { ok: false, patches: [], error: 'missing HP_DELTA' };
    },
    applyUpdate(base, parsed) {
      const next = JSON.parse(JSON.stringify(base));
      next.player.hp += parsed[0].hpDelta;
      return { statData: next, applied: 1, errors: [] };
    },
  };
  const tc = generateCase(customPreset, 1001, { k: 1 });
  const delta = tc.expectedPatches[0].value;
  const g = gradeUpdaterOutput(customPreset, tc, `<MyCustomFormat>HP_DELTA=${delta}</MyCustomFormat>`);
  assert.equal(g.allPassed, true);
});

test('buildRealisticHistoryFiller is deterministic and meets target length', () => {
  const a = buildRealisticHistoryFiller(3021, 5000);
  const b = buildRealisticHistoryFiller(3021, 5000);
  assert.equal(a, b);
  assert.ok(a.length >= 5000);
  assert.equal(buildRealisticHistoryFiller(3021, 0), '');
});

test('buildBlindUpdaterPrompt injects settled long-context history between rules and stat_data', () => {
  const tc = generateCase(minimalPreset, 3021, { k: 2 });
  const story = 'Aria takes a deep breath in the tavern.';
  const longPrompt = buildBlindUpdaterPrompt(minimalPreset, tc, story, { contextChars: 4000 });
  const rulesIdx = longPrompt.indexOf('=== VARIABLE UPDATE RULES ===');
  const histIdx = longPrompt.indexOf('=== PRIOR SETTLED RP HISTORY');
  const stateIdx = longPrompt.indexOf('=== CURRENT stat_data ===');
  assert.ok(rulesIdx >= 0 && histIdx > rulesIdx && stateIdx > histIdx);
  assert.ok(longPrompt.length > 4500);
  assert.ok(!longPrompt.includes('expectedPatches'));

  const customPreset = { ...minimalPreset, buildHistoryFiller: (seed, chars) => `CUSTOM_HIST_${seed}_${chars}` };
  const customPrompt = buildBlindUpdaterPrompt(customPreset, tc, story, { contextChars: 1234 });
  assert.ok(customPrompt.includes('CUSTOM_HIST_3021_1234'));
});

test('buildHeatmapReport includes Standard vs Long-Context comparison when mixed', () => {
  const tcStd = generateCase(minimalPreset, 1001, { k: 2 });
  const tcLng = generateCase(minimalPreset, 1002, { k: 2 });
  const gStd = gradeUpdaterOutput(minimalPreset, tcStd, `<UpdateVariable><JSONPatch>${JSON.stringify(tcStd.expectedPatches)}</JSONPatch></UpdateVariable>`);
  gStd.isLongContext = false;
  const gLng = gradeUpdaterOutput(minimalPreset, tcLng, `<UpdateVariable><JSONPatch>${JSON.stringify(tcLng.expectedPatches)}</JSONPatch></UpdateVariable>`);
  gLng.isLongContext = true;
  const rep = buildHeatmapReport([gStd, gLng], { model: 'test-model' });
  assert.ok(rep.markdown.includes('Context Comparison: Standard'));
  assert.ok(rep.markdown.includes('Long-Context'));
});

await test('buildCompareReport flags long-context truncation, accuracy drop, and cache bypass', () => {
  const mkRes = (seed, isLong, passAll, cacheHit) => {
    const tc = generateCase(minimalPreset, seed, { k: 2 });
    const raw = passAll
      ? `<UpdateVariable><JSONPatch>${JSON.stringify(tc.expectedPatches)}</JSONPatch></UpdateVariable>`
      : `<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>`;
    const g = gradeUpdaterOutput(minimalPreset, tc, raw);
    g.isLongContext = isLong;
    g.elapsedMs = 1200;
    g.usage = { promptTokens: 10000, completionTokens: 200, cacheHitTokens: cacheHit };
    return g;
  };
  const base = [mkRes(1001, false, true, 0), mkRes(1002, false, true, 9000), mkRes(1003, true, true, 9000), mkRes(1004, true, true, 9000)];
  const cand = [mkRes(1001, false, true, 0), mkRes(1002, false, true, 0), mkRes(1003, true, false, 0), mkRes(1004, true, false, 0)];
  const cmp = buildCompareReport(base, cand, { baselineLabel: 'Official', candidateLabel: 'SneakyRelay' });
  const codes = cmp.flags.map((f) => f.code);
  assert.ok(codes.includes('LONG_CONTEXT_TRUNCATION_SUSPECT'));
  assert.ok(codes.includes('ACCURACY_DEGRADATION_SUSPECT'));
  assert.ok(codes.includes('CACHE_BYPASS_SUSPECT'));
  assert.ok(cmp.markdown.includes('Divergent Seeds'));

  const clean = buildCompareReport(base, base, { baselineLabel: 'Official', candidateLabel: 'HonestRelay' });
  assert.deepEqual(clean.flags.map((f) => f.code), ['CONSISTENT_WITH_BASELINE']);
});

await test('CLI `compare` end-to-end against local mock baseline vs context-truncating relay', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvu-seedfuzz-cmp-'));
  const storyDir = path.join(tmpDir, 'stories');
  fs.mkdirSync(storyDir, { recursive: true });

  const seeds = [1001, 1002, 1003, 1004];
  const answerByStoryMarker = new Map();
  for (const s of seeds) {
    const tc = generateCase(minimalPreset, s, { k: 2 });
    const marker = `MOCK_SEED_MARKER_${s}`;
    const story = `${marker} ${tc.picked.map((p) => p.storyFact).join(' ')} `.padEnd(120, '.');
    fs.writeFileSync(path.join(storyDir, `story_${s}.txt`), story, 'utf8');
    answerByStoryMarker.set(marker, `<UpdateVariable><JSONPatch>${JSON.stringify(tc.expectedPatches)}</JSONPatch></UpdateVariable>`);
  }

  const startMock = (sneaky) => new Promise((resolve) => {
    let reqCount = 0;
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        reqCount++;
        const parsed = JSON.parse(body || '{}');
        const prompt = parsed?.messages?.[0]?.content || '';
        let reply = '<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>';
        if (!(sneaky && prompt.length > 4000)) {
          for (const [marker, ans] of answerByStoryMarker.entries()) {
            if (prompt.includes(marker)) { reply = ans; break; }
          }
        }
        const promptTokens = Math.max(500, Math.floor(prompt.length / 2));
        const cacheHit = !sneaky && reqCount > 1 ? Math.floor(promptTokens * 0.9) : 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: reply } }],
          usage: { prompt_tokens: promptTokens, completion_tokens: 120, prompt_cache_hit_tokens: cacheHit },
        }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/v1/chat/completions` }));
  });

  const baseSrv = await startMock(false);
  const candSrv = await startMock(true);
  try {
    const jsonOut = path.join(tmpDir, 'compare.json');
    const mdOut = path.join(tmpDir, 'compare.md');
    await execFileAsync(process.execPath, [
      path.resolve('src/cli.mjs'),
      'compare',
      '--preset', path.resolve('presets/minimal-rpg.mjs'),
      '--seeds', '1001..1004',
      '--long-seeds', '1003..1004',
      '--context-chars', '4500',
      '--k', '2',
      '--concurrency', '1',
      '--temperature', '0',
      '--story-dir', storyDir,
      '--baseline-url', baseSrv.url,
      '--baseline-model', 'mock-official',
      '--candidate-url', candSrv.url,
      '--candidate-model', 'mock-sneaky-relay',
      '--json-out', jsonOut,
      '--md-out', mdOut,
    ]);
    const data = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
    const md = fs.readFileSync(mdOut, 'utf8');
    assert.equal(data.baseline.hitRatePct, 100);
    assert.equal(data.candidate.standard.hitRatePct, 100);
    assert.equal(data.candidate.longContext.hitRatePct, 0);
    const codes = data.flags.map((f) => f.code);
    assert.ok(codes.includes('LONG_CONTEXT_TRUNCATION_SUSPECT'));
    assert.ok(codes.includes('CACHE_BYPASS_SUSPECT'));
    assert.ok(md.includes('MVU-SeedFuzz A/B Endpoint Audit Report'));
  } finally {
    baseSrv.srv.close();
    candSrv.srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

console.log(`\nAll ${passed} tests passed!`);
