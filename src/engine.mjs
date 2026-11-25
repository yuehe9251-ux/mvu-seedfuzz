/**
 * mvu-seedfuzz · Generic Seed-Driven Reverse-Oracle Variable Fuzzing Engine
 *
 * Works with ANY SillyTavern / MVU / AI RP variable card preset:
 *   preset = {
 *     name: string,
 *     createBaseState(): object,
 *     runOracle(state, turnIndex): object,          // optional deterministic monitor / derived-stat calculator
 *     loadRules(options): string,                   // worldbook / system rules injected into AI-B (blind)
 *     formatStateSummary?(baseState): string,       // concise state summary injected into AI-A (story writer)
 *     checkDrift?(actual, base, picked): string[],  // optional guardrails against unintended mutations
 *     operators: Array<{
 *       id, domain, name, conflicts?: string[],
 *       build(rng, baseState): {
 *         storyFact: string,
 *         requiredTokens?: string[],
 *         expectedPatches: Array<{ op, path, value? }>,
 *         verify(actual, expected, base): { ok: boolean, detail: string }
 *       }
 *     }>
 *   }
 */

export function deepClone(x) {
  if (x === undefined || x === null) return x;
  return JSON.parse(JSON.stringify(x));
}

/** Mulberry32 deterministic PRNG: identical seed always generates the exact same mutation vector. */
export function mulberry32(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

export function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function splitPointer(ptr) {
  return String(ptr || '')
    .replace(/^stat_data\/?/i, '')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** Apply RFC-6902 JSONPatch + MVU `delta` op onto a cloned state object. */
export function applyMvuPatches(baseObj, patches) {
  const out = deepClone(baseObj);
  const errors = [];
  if (!Array.isArray(patches)) {
    return { statData: out, applied: 0, errors: ['patches is not an array'] };
  }
  let applied = 0;
  for (let i = 0; i < patches.length; i++) {
    const p = patches[i];
    if (!p || typeof p !== 'object' || !p.op || !p.path) {
      errors.push(`#${i}: missing op or path`);
      continue;
    }
    const op = String(p.op).toLowerCase().trim();
    const segs = splitPointer(p.path);
    if (!segs.length) {
      errors.push(`#${i}: empty path "${p.path}"`);
      continue;
    }
    const lastKey = segs[segs.length - 1];
    let parent = out;
    let broken = false;
    for (let j = 0; j < segs.length - 1; j++) {
      const k = segs[j];
      if (parent[k] === undefined || parent[k] === null || typeof parent[k] !== 'object') {
        if (op === 'add' || op === 'replace' || op === 'delta' || op === 'set' || op === 'insert') {
          parent[k] = {};
        } else {
          broken = true;
          break;
        }
      }
      parent = parent[k];
    }
    if (broken) {
      errors.push(`#${i}: parent path missing "${p.path}"`);
      continue;
    }

    if (op === 'delta') {
      const cur = Number(parent[lastKey] || 0);
      const dv = Number(p.value);
      if (!Number.isFinite(dv)) {
        errors.push(`#${i}: non-numeric delta value at "${p.path}"`);
        continue;
      }
      parent[lastKey] = cur + dv;
      applied++;
    } else if (op === 'add' || op === 'replace' || op === 'set' || op === 'insert') {
      if (p.value === undefined) {
        errors.push(`#${i}: missing value at "${p.path}"`);
        continue;
      }
      parent[lastKey] = deepClone(p.value);
      applied++;
    } else if (op === 'remove' || op === 'delete') {
      if (Array.isArray(parent)) {
        const idx = Number(lastKey);
        if (Number.isInteger(idx) && idx >= 0 && idx < parent.length) parent.splice(idx, 1);
      } else {
        delete parent[lastKey];
      }
      applied++;
    } else {
      errors.push(`#${i}: unknown op "${p.op}"`);
    }
  }
  return { statData: out, applied, errors };
}

/** Extract JSONPatch array from `<UpdateVariable><JSONPatch>[...]</JSONPatch></UpdateVariable>` or fenced JSON. */
export function extractPatchesFromOutput(rawText) {
  const txt = String(rawText || '');
  const candidates = [];
  const jpMatch = txt.match(/<JSONPatch>([\s\S]*?)<\/JSONPatch>/i);
  if (jpMatch) candidates.push(jpMatch[1]);
  const uvMatch = txt.match(/<UpdateVariable>([\s\S]*?)<\/UpdateVariable>/i);
  if (uvMatch) candidates.push(uvMatch[1]);
  const fenceMatch = txt.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/i);
  if (fenceMatch) candidates.push(fenceMatch[1]);
  const arrMatch = txt.match(/(\[\s*\{[\s\S]*?\}\s*\])/);
  if (arrMatch) candidates.push(arrMatch[1]);

  for (const raw of candidates) {
    const cleaned = raw
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,\s*([}\]])/g, '$1')
      .trim();
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(cleaned.slice(start, end + 1));
        if (Array.isArray(parsed)) return { ok: true, patches: parsed, error: null };
      } catch (e) {
        // try next candidate
      }
    }
  }
  return { ok: false, patches: [], error: 'Failed to parse a valid <JSONPatch> array from model output' };
}

function runPresetOracle(preset, state, turnIndex) {
  if (typeof preset.runOracle === 'function') {
    return preset.runOracle(deepClone(state), turnIndex);
  }
  return deepClone(state);
}

/**
 * Deterministically generate 1 fuzz test case from `preset` and `seed`.
 */
export function generateCase(preset, seed, options = {}) {
  const ops = preset.operators || [];
  const k = Math.max(1, Math.min(ops.length, Number(options.k || 4)));
  const storyChars = Math.max(120, Number(options.storyChars ?? 2500));
  const rng = mulberry32(seed);
  const baseStatData = runPresetOracle(preset, preset.createBaseState(), 1);

  const indices = ops.map((_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  const usedConflicts = new Set();
  const picked = [];
  for (const idx of indices) {
    if (picked.length >= k) break;
    const opDef = ops[idx];
    const hasConflict = (opDef.conflicts || []).some((c) => usedConflicts.has(c));
    if (hasConflict) continue;
    (opDef.conflicts || []).forEach((c) => usedConflicts.add(c));
    const built = opDef.build(rng, baseStatData);
    picked.push({
      opIndex: idx,
      id: opDef.id,
      domain: opDef.domain,
      name: opDef.name,
      conflicts: opDef.conflicts || [],
      storyFact: built.storyFact,
      requiredTokens: built.requiredTokens || [],
      expectedPatches: built.expectedPatches || [],
      _verify: built.verify,
    });
  }

  const expectedPatches = picked.flatMap((p) => p.expectedPatches);
  const patched = applyMvuPatches(baseStatData, expectedPatches);
  const expectedStatData = runPresetOracle(preset, patched.statData, 2);

  const stateSummary = typeof preset.formatStateSummary === 'function'
    ? preset.formatStateSummary(baseStatData)
    : JSON.stringify(baseStatData, null, 2);

  const factsBullets = picked.map((p, i) => `${i + 1}. [${p.domain} · ${p.name}] ${p.storyFact}`).join('\n');
  const lowChars = Math.max(100, Math.round(storyChars * 0.88));
  const highChars = Math.round(storyChars * 1.12);
  const paraGuide = storyChars >= 1800 ? '6-10 rich paragraphs' : (storyChars >= 800 ? '3-5 paragraphs' : '2-3 paragraphs');
  const storyPrompt = [
    `You are a strict reverse-oracle RP story writer for preset "${preset.name}" (SEED=${seed}).`,
    `Write an immersive RP story turn of approximately **${storyChars} characters** (strictly ${lowChars}-${highChars} characters across ${paraGuide}) in the language of the facts below that embeds EVERY listed mutation cleanly.`,
    ``,
    `[HARD RULES — ANY VIOLATION INVALIDATES THE TEST]`,
    `1. Length requirement: total prose length MUST be within ${lowChars}-${highChars} characters. Use vivid scene atmosphere, dialogue, action choreography, and inner monologue to fill the turn naturally, scattering the ${picked.length} mutations evenly across the beginning, middle, and end (never dump a dry bullet summary).`,
    `2. Every single fact, exact number, item/skill/quest/NPC name, and duration in the list MUST appear naturally in the story prose.`,
    `3. NEVER invent extra side effects: no unrequested free items, no extra gold/EXP/affection, no extra time skips, no unrequested HP/AP changes.`,
    `4. Output ONLY pure story prose. NEVER output JSON, XML, <UpdateVariable>, <JSONPatch>, or code fences.`,
    ``,
    `[INITIAL STATE SUMMARY]`,
    stateSummary,
    ``,
    `[EXACT ${picked.length} MUTATIONS THAT MUST OCCUR THIS TURN]`,
    factsBullets,
  ].join('\n');

  return {
    presetName: preset.name,
    seed: Number(seed),
    k: picked.length,
    storyChars,
    vectorIndices: picked.map((p) => p.opIndex),
    picked,
    baseStatData,
    expectedPatches,
    expectedStatData,
    storyPrompt,
  };
}

/** Gate check on AI-A's synthesized story: catch missing numbers/names, leaked patch tags, or undersized prose BEFORE testing AI-B. */
export function verifyGeneratedStory(testCase, storyText, options = {}) {
  const txt = String(storyText || '').trim();
  const missing = [];
  for (const op of testCase.picked) {
    for (const tok of op.requiredTokens) {
      if (!txt.includes(tok)) missing.push({ opId: op.id, token: tok });
    }
  }
  const hasLeakTag = /<UpdateVariable|<JSONPatch|\{"op"\s*:/i.test(txt);
  const targetChars = Number(options.storyChars ?? testCase.storyChars ?? 2500);
  const minLength = Math.max(60, Math.floor(targetChars * 0.72));
  const tooShort = txt.length < minLength;
  return {
    ok: missing.length === 0 && !hasLeakTag && !tooShort,
    missing,
    hasLeakTag,
    tooShort,
    minLength,
    targetChars,
    length: txt.length,
  };
}

/**
 * Generate deterministic, realistic prior-turn RP history containing numerical distractors
 * (old shop prices, old HP damage, old potion uses) explicitly marked as already-settled turns.
 * Used to benchmark long-context rule recall & resistance to historical-number bleed-through.
 */
export function buildRealisticHistoryFiller(seed, targetChars) {
  const goal = Math.max(0, Number(targetChars || 0));
  if (goal <= 0) return '';
  const rng = mulberry32((Number(seed) || 1) ^ 0x9E3779B9);
  const scenes = [
    (t, n) => `[Prior Turn ${t} · Market Square Patrol] Earlier in the afternoon, the party passed the bustling square where a street stall advertised iron daggers for ${200 + n * 15} gold and roasted skewers for ${45 + n * 5} gold. Nobody bought anything; all prior expenses and inventory states from that stroll were already settled in the system log before the current turn.`,
    (t, n) => `[Prior Turn ${t} · Tavern Tactical Debrief] Over a flickering oil lamp at the inn, the team reviewed an old skirmish from two days ago where they had taken ${95 + n * 8} points of glancing damage and drank ${1 + (n % 3)} healing potions—both already fully recovered and recorded in earlier turns. They discussed flank timing and guard cadence before packing up.`,
    (t, n) => `[Prior Turn ${t} · Outer Ruins Scouting] Damp moss clung to the stone arches as the scouts estimated a distant patrol's aggro radius at ${16 + (n % 14)} meters. Along the road they guided a lost traveler back toward the south gate and politely declined the traveler's offer of ${140 + n * 10} gold and ${2 + (n % 4)} travel rations (pure transition dialogue; no item or currency transfer occurred).`,
    (t, n) => `[Prior Turn ${t} · Forge & Smithy Banter] Sparks showered from the anvil while the veteran blacksmith shared stories about masterwork tempering and how a shield knight once spent ${850 + n * 25} gold on ore last week. After inspecting their scabbards, the party thanked the smith and walked back down the lantern-lit avenue.`,
    (t, n) => `[Prior Turn ${t} · Guild Hall Evening Notes] Notices fluttered on the guild board listing fog visibility down to ${25 + (n % 20)} meters along the northern ravine and rumored side passages beyond the tower entrance. Every past errand, ledger entry, and resource change from previous chapters has already been finalized and archived.`,
  ];
  const chunks = [];
  let len = 0;
  let turn = 1;
  while (len < goal) {
    const fn = scenes[Math.floor(rng() * scenes.length) % scenes.length];
    const line = fn(turn, Math.floor(rng() * 40));
    chunks.push(line);
    len += line.length + 2;
    turn++;
  }
  return chunks.join('\n\n');
}

/** Build blind prompt for AI-B (target model): ONLY real card rules + optional settled history + initial state + story prose. */
export function buildBlindUpdaterPrompt(preset, testCase, storyText, options = {}) {
  const rules = typeof preset.loadRules === 'function' ? preset.loadRules(options) : '';
  const stateForPrompt = typeof preset.sanitizeStateForPrompt === 'function'
    ? preset.sanitizeStateForPrompt(deepClone(testCase.baseStatData))
    : deepClone(testCase.baseStatData);

  const ctxChars = Math.max(0, Number(options.contextChars ?? options['context-chars'] ?? 0));
  const historyBody = ctxChars > 0
    ? (typeof preset.buildHistoryFiller === 'function'
      ? preset.buildHistoryFiller(testCase.seed, ctxChars)
      : buildRealisticHistoryFiller(testCase.seed, ctxChars))
    : '';
  const historyBlock = historyBody
    ? [
      ``,
      `=== PRIOR SETTLED RP HISTORY (ALREADY FINALIZED — DO NOT RE-APPLY OLD EVENTS OR NUMBERS) ===`,
      historyBody,
      `=== END OF PRIOR HISTORY (ONLY EVALUATE THE NEW RP STORY TURN BELOW) ===`,
    ].join('\n')
    : '';

  return [
    `You are an AI RP / SillyTavern MVU state-update engine.`,
    `Strictly follow the rules below to convert the new RP story turn into precise JSONPatch updates against the current stat_data.`,
    `Output ONLY an <UpdateVariable><JSONPatch>[...]</JSONPatch></UpdateVariable> block (valid JSON array, no story recap).`,
    ctxChars > 0
      ? `CRITICAL: Any prior RP history included below has ALREADY been settled. Emit updates ONLY for the final === NEW RP STORY TURN ===.`
      : null,
    ``,
    `=== VARIABLE UPDATE RULES ===`,
    rules,
    historyBlock,
    ``,
    `=== CURRENT stat_data ===`,
    JSON.stringify(stateForPrompt),
    ``,
    `=== NEW RP STORY TURN ===`,
    storyText,
  ].filter((x) => x !== null).join('\n');
}

/** Grade AI-B's blind output through the real preset oracle and detect unintended drift. */
export function gradeUpdaterOutput(preset, testCase, rawModelOutput) {
  const parsed = typeof preset.parseModelOutput === 'function'
    ? preset.parseModelOutput(rawModelOutput)
    : extractPatchesFromOutput(rawModelOutput);
  if (!parsed || !parsed.ok) {
    return {
      seed: testCase.seed,
      parseOk: false,
      parseError: (parsed && parsed.error) || 'Failed to parse model output',
      patchCount: 0,
      patchErrors: [],
      passedOps: 0,
      totalOps: testCase.picked.length,
      allPassed: false,
      opResults: testCase.picked.map((op) => ({
        opIndex: op.opIndex,
        id: op.id,
        domain: op.domain,
        name: op.name,
        ok: false,
        detail: (parsed && parsed.error) || 'Failed to parse model output',
      })),
      driftWarnings: [],
    };
  }

  const applied = typeof preset.applyUpdate === 'function'
    ? preset.applyUpdate(testCase.baseStatData, parsed.patches)
    : applyMvuPatches(testCase.baseStatData, parsed.patches);
  const actualStatData = runPresetOracle(preset, applied.statData, 2);

  const opResults = testCase.picked.map((op) => {
    const res = op._verify(actualStatData, testCase.expectedStatData, testCase.baseStatData);
    return {
      opIndex: op.opIndex,
      id: op.id,
      domain: op.domain,
      name: op.name,
      ok: !!res.ok,
      detail: res.detail || '',
    };
  });

  const driftWarnings = typeof preset.checkDrift === 'function'
    ? (preset.checkDrift(actualStatData, testCase.baseStatData, testCase.picked) || [])
    : [];

  const passedOps = opResults.filter((r) => r.ok).length;
  return {
    seed: testCase.seed,
    parseOk: true,
    parseError: null,
    patchCount: parsed.patches.length,
    patchErrors: applied.errors,
    passedOps,
    totalOps: opResults.length,
    allPassed: passedOps === opResults.length && driftWarnings.length === 0,
    opResults,
    driftWarnings,
  };
}

/** Aggregate multiple seed verdicts into a per-variable vulnerability heatmap (Markdown + JSON). */
export function buildHeatmapReport(results, meta = {}) {
  const byOp = new Map();
  for (const r of results) {
    for (const o of (r.opResults || [])) {
      if (!byOp.has(o.id)) byOp.set(o.id, { id: o.id, domain: o.domain, name: o.name, total: 0, pass: 0, failSeeds: [] });
      const st = byOp.get(o.id);
      st.total += 1;
      if (o.ok) st.pass += 1;
      else st.failSeeds.push({ seed: r.seed, detail: o.detail });
    }
  }
  const rows = Array.from(byOp.values()).sort((a, b) => (a.pass / a.total) - (b.pass / b.total) || b.total - a.total);
  const totalOps = rows.reduce((s, r) => s + r.total, 0);
  const totalPass = rows.reduce((s, r) => s + r.pass, 0);
  const fullPassSeeds = results.filter((r) => r.allPassed).length;
  const hitRatePct = totalOps ? Math.round((totalPass * 1000) / totalOps) / 10 : 0;

  const stdResults = results.filter((r) => !r.isLongContext);
  const longResults = results.filter((r) => !!r.isLongContext);
  const formatGroup = (arr) => {
    if (!arr.length) return '0/0';
    const passS = arr.filter((r) => r.allPassed).length;
    const passO = arr.reduce((s, r) => s + Number(r.passedOps || 0), 0);
    const totO = arr.reduce((s, r) => s + Number(r.totalOps || 0), 0);
    const pct = totO ? Math.round((passO * 1000) / totO) / 10 : 0;
    return `seeds **${passS}/${arr.length}**, ops **${passO}/${totO}** (**${pct}%**)`;
  };

  const title = meta.title || 'MVU-SeedFuzz Variable Vulnerability Heatmap';
  const lines = [
    `# ${title}`,
    ``,
    meta.model ? `- Target Model: **${meta.model}**` : null,
    `- Seeds Tested: **${results.length}** (All-Pass Seeds: **${fullPassSeeds}/${results.length}**)`,
    `- Atomic Variable Hit Rate: **${totalPass}/${totalOps}** (**${hitRatePct}%**)`,
    longResults.length > 0
      ? `- Context Comparison: Standard (${formatGroup(stdResults)}) | Long-Context (${formatGroup(longResults)})`
      : null,
    ``,
    `| Domain | Operator ID | Variable Mutation | Pass/Total | Hit Rate | Failing Seeds & Diagnostics |`,
    `| :--- | :--- | :--- | :---: | :---: | :--- |`,
  ].filter((x) => x !== null);

  for (const row of rows) {
    const rate = Math.round((row.pass * 1000) / Math.max(1, row.total)) / 10;
    const badge = rate === 100 ? '🟢' : (rate >= 50 ? '🟡' : '🔴');
    const fails = row.failSeeds.length
      ? row.failSeeds.map((f) => `seed=${f.seed}(${f.detail})`).join('; ')
      : '—';
    lines.push(`| ${row.domain} | \`${row.id}\` | ${row.name} | ${row.pass}/${row.total} | ${badge} ${rate}% | ${fails} |`);
  }

  return {
    summary: { seeds: results.length, fullPassSeeds, totalOps, totalPass, hitRatePct },
    rows,
    markdown: lines.join('\n'),
  };
}

function summarizeEndpointResults(results) {
  const arr = Array.isArray(results) ? results : [];
  const calcGroup = (sub) => {
    const seeds = sub.length;
    const fullPassSeeds = sub.filter((r) => r.allPassed).length;
    const totalOps = sub.reduce((s, r) => s + Number(r.totalOps || 0), 0);
    const totalPass = sub.reduce((s, r) => s + Number(r.passedOps || 0), 0);
    const hitRatePct = totalOps ? Math.round((totalPass * 1000) / totalOps) / 10 : 0;
    return { seeds, fullPassSeeds, totalOps, totalPass, hitRatePct };
  };
  const all = calcGroup(arr);
  const standard = calcGroup(arr.filter((r) => !r.isLongContext));
  const longContext = calcGroup(arr.filter((r) => !!r.isLongContext));

  const parseFails = arr.filter((r) => !r.parseOk).length;
  const parseFailRatePct = arr.length ? Math.round((parseFails * 1000) / arr.length) / 10 : 0;
  const driftSeeds = arr.filter((r) => (r.driftWarnings || []).length > 0).length;

  const latencies = arr.map((r) => Number(r.elapsedMs || 0)).filter((x) => x > 0).sort((a, b) => a - b);
  const avgLatencyMs = latencies.length ? Math.round(latencies.reduce((s, x) => s + x, 0) / latencies.length) : 0;
  const p95LatencyMs = latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : 0;

  const promptTokens = arr.reduce((s, r) => s + Number(r.usage?.promptTokens ?? r.usage?.prompt_tokens ?? 0), 0);
  const completionTokens = arr.reduce((s, r) => s + Number(r.usage?.completionTokens ?? r.usage?.completion_tokens ?? 0), 0);
  const cacheHitTokens = arr.reduce((s, r) => s + Number(r.usage?.cacheHitTokens ?? r.usage?.prompt_cache_hit_tokens ?? 0), 0);
  const cacheHitRatePct = promptTokens ? Math.round((cacheHitTokens * 1000) / promptTokens) / 10 : 0;

  return {
    ...all,
    standard,
    longContext,
    parseFails,
    parseFailRatePct,
    driftSeeds,
    avgLatencyMs,
    p95LatencyMs,
    promptTokens,
    completionTokens,
    cacheHitTokens,
    cacheHitRatePct,
  };
}

/**
 * Compare two endpoints (e.g., Official Direct API vs Third-Party Relay / Candidate Model)
 * evaluated on the exact same frozen seeds & blind prompts.
 * Produces objective accuracy, long-context retention, format stability, latency & cache-passthrough diagnostics.
 */
export function buildCompareReport(baselineResults, candidateResults, meta = {}) {
  const baseLabel = meta.baselineLabel || 'Baseline (Official)';
  const candLabel = meta.candidateLabel || 'Candidate (Relay)';
  const base = summarizeEndpointResults(baselineResults);
  const cand = summarizeEndpointResults(candidateResults);

  const r1 = (n) => Math.round(n * 10) / 10;
  const fmtDelta = (d, unit = '%') => `${d >= 0 ? '+' : ''}${r1(d)}${unit}`;

  const hitDelta = r1(cand.hitRatePct - base.hitRatePct);
  const stdDelta = base.standard.seeds && cand.standard.seeds ? r1(cand.standard.hitRatePct - base.standard.hitRatePct) : null;
  const longDelta = base.longContext.seeds && cand.longContext.seeds ? r1(cand.longContext.hitRatePct - base.longContext.hitRatePct) : null;
  const parseFailDelta = r1(cand.parseFailRatePct - base.parseFailRatePct);
  const cacheDelta = r1(cand.cacheHitRatePct - base.cacheHitRatePct);

  const flags = [];
  if (longDelta !== null && longDelta <= -20) {
    flags.push({
      code: 'LONG_CONTEXT_TRUNCATION_SUSPECT',
      severity: 'HIGH',
      message: `Long-context hit rate dropped ${fmtDelta(longDelta)} (${base.longContext.hitRatePct}% -> ${cand.longContext.hitRatePct}%). Strongly suggests silent context truncation or severe long-context degradation.`,
    });
  } else if (
    cand.longContext.seeds > 0
    && cand.standard.seeds > 0
    && (cand.standard.hitRatePct - cand.longContext.hitRatePct) >= 25
    && (base.standard.hitRatePct - base.longContext.hitRatePct) < 10
  ) {
    flags.push({
      code: 'LONG_CONTEXT_TRUNCATION_SUSPECT',
      severity: 'HIGH',
      message: `Candidate dropped ${r1(cand.standard.hitRatePct - cand.longContext.hitRatePct)}% from standard to long-context while baseline stayed stable.`,
    });
  }

  if (hitDelta <= -10) {
    flags.push({
      code: 'ACCURACY_DEGRADATION_SUSPECT',
      severity: 'HIGH',
      message: `Overall atomic variable hit rate is ${fmtDelta(hitDelta)} below baseline (${base.hitRatePct}% -> ${cand.hitRatePct}%) on identical prompts. Suspect model downgrade, parameter tampering, or prompt mutation.`,
    });
  }

  if (parseFailDelta >= 10) {
    flags.push({
      code: 'FORMAT_INSTABILITY_SUSPECT',
      severity: 'MEDIUM',
      message: `JSONPatch parse failure rate rose ${fmtDelta(parseFailDelta)} (${base.parseFailRatePct}% -> ${cand.parseFailRatePct}%).`,
    });
  }

  if (base.cacheHitRatePct >= 30 && (cand.cacheHitRatePct === 0 || cacheDelta <= -25)) {
    flags.push({
      code: 'CACHE_BYPASS_SUSPECT',
      severity: 'MEDIUM',
      message: `Baseline achieved ${base.cacheHitRatePct}% prefix cache hit rate vs candidate ${cand.cacheHitRatePct}%. Suspect unforwarded prefix caching or injected prompt modifications.`,
    });
  }

  if (!flags.length) {
    flags.push({
      code: 'CONSISTENT_WITH_BASELINE',
      severity: 'OK',
      message: 'No statistically notable degradation detected across accuracy, long-context retention, JSON format stability, or prefix caching.',
    });
  }

  const baseBySeed = new Map((baselineResults || []).map((r) => [r.seed, r]));
  const candBySeed = new Map((candidateResults || []).map((r) => [r.seed, r]));
  const allSeeds = Array.from(new Set([...baseBySeed.keys(), ...candBySeed.keys()])).sort((a, b) => a - b);

  const seedDiffRows = [];
  for (const s of allSeeds) {
    const b = baseBySeed.get(s);
    const c = candBySeed.get(s);
    if (!b || !c) continue;
    if (b.passedOps !== c.passedOps || b.parseOk !== c.parseOk || b.allPassed !== c.allPassed) {
      const mode = b.isLongContext ? 'LONG' : 'STD';
      const bTag = b.parseOk ? `${b.passedOps}/${b.totalOps}` : 'PARSE_ERR';
      const cTag = c.parseOk ? `${c.passedOps}/${c.totalOps}` : 'PARSE_ERR';
      const cFails = (c.opResults || []).filter((x) => !x.ok).map((x) => `${x.id}(${x.detail})`).join('; ') || '—';
      seedDiffRows.push(`| ${s} | ${mode} | ${bTag} | ${cTag} | ${cFails} |`);
    }
  }

  const title = meta.title || 'MVU-SeedFuzz A/B Endpoint Audit Report';
  const lines = [
    `# ${title}`,
    ``,
    `- **Baseline**: \`${baseLabel}\``,
    `- **Candidate**: \`${candLabel}\``,
    `- **Matched Seeds**: **${allSeeds.length}** (Standard: **${base.standard.seeds}**, Long-Context: **${base.longContext.seeds}**)`,
    ``,
    `## 1. Side-by-Side Metrics`,
    ``,
    `| Metric | ${baseLabel} | ${candLabel} | Delta (Cand - Base) |`,
    `| :--- | :---: | :---: | :---: |`,
    `| All-Pass Seeds | ${base.fullPassSeeds}/${base.seeds} | ${cand.fullPassSeeds}/${cand.seeds} | ${cand.fullPassSeeds - base.fullPassSeeds >= 0 ? '+' : ''}${cand.fullPassSeeds - base.fullPassSeeds} |`,
    `| Overall Atomic Hit Rate | **${base.hitRatePct}%** (${base.totalPass}/${base.totalOps}) | **${cand.hitRatePct}%** (${cand.totalPass}/${cand.totalOps}) | **${fmtDelta(hitDelta)}** |`,
    stdDelta !== null
      ? `| Standard Context Hit Rate | ${base.standard.hitRatePct}% (${base.standard.totalPass}/${base.standard.totalOps}) | ${cand.standard.hitRatePct}% (${cand.standard.totalPass}/${cand.standard.totalOps}) | ${fmtDelta(stdDelta)} |`
      : null,
    longDelta !== null
      ? `| Long-Context Hit Rate | ${base.longContext.hitRatePct}% (${base.longContext.totalPass}/${base.longContext.totalOps}) | ${cand.longContext.hitRatePct}% (${cand.longContext.totalPass}/${cand.longContext.totalOps}) | **${fmtDelta(longDelta)}** |`
      : null,
    `| JSON Parse Failure Rate | ${base.parseFailRatePct}% (${base.parseFails}/${base.seeds}) | ${cand.parseFailRatePct}% (${cand.parseFails}/${cand.seeds}) | ${fmtDelta(parseFailDelta)} |`,
    `| Untouched-Domain Drift Seeds | ${base.driftSeeds}/${base.seeds} | ${cand.driftSeeds}/${cand.seeds} | ${cand.driftSeeds - base.driftSeeds >= 0 ? '+' : ''}${cand.driftSeeds - base.driftSeeds} |`,
    `| Avg / P95 Latency | ${base.avgLatencyMs}ms / ${base.p95LatencyMs}ms | ${cand.avgLatencyMs}ms / ${cand.p95LatencyMs}ms | ${fmtDelta(cand.avgLatencyMs - base.avgLatencyMs, 'ms')} |`,
    `| Prefix Cache Hit Rate | ${base.cacheHitRatePct}% (${base.cacheHitTokens}/${base.promptTokens}) | ${cand.cacheHitRatePct}% (${cand.cacheHitTokens}/${cand.promptTokens}) | ${fmtDelta(cacheDelta)} |`,
    ``,
    `## 2. Automated Diagnostic Signals`,
    ``,
    ...flags.map((f) => {
      const icon = f.severity === 'HIGH' ? '🔴' : (f.severity === 'MEDIUM' ? '🟡' : '🟢');
      return `- ${icon} **\`${f.code}\`**: ${f.message}`;
    }),
    ``,
    `## 3. Divergent Seeds (Baseline ≠ Candidate)`,
    ``,
  ].filter((x) => x !== null);

  if (seedDiffRows.length) {
    lines.push('| Seed | Mode | Baseline | Candidate | Candidate Diagnostics |');
    lines.push('| :---: | :---: | :---: | :---: | :--- |');
    lines.push(...seedDiffRows);
  } else {
    lines.push('_Zero divergent seeds — both endpoints achieved identical pass/fail scores on every seed._');
  }

  return {
    baseline: base,
    candidate: cand,
    deltas: { hitDelta, stdDelta, longDelta, parseFailDelta, cacheDelta },
    flags,
    markdown: lines.join('\n'),
  };
}

/**
 * Compute a deterministic verifiable reward (RLVR / GRPO / RFT) from a graded evaluation record.
 * Reward range: [-0.5, 1.0]. Zero LLM-as-a-judge variance.
 *   - Parse failure: -0.5
 *   - Valid format: +0.1
 *   - Exact oracle operator hit ratio: +0.7 * (passedOps / totalOps)
 *   - Zero untouched-domain drift: +0.2 (drift present: -0.3)
 *   - Patch apply errors penalty: -min(0.2, patchErrors.length * 0.05)
 */
export function computeVerifiableReward(grade) {
  if (!grade || !grade.parseOk) {
    return {
      reward: -0.5,
      breakdown: { format: -0.5, accuracy: 0, drift: 0, patchPenalty: 0 },
      acceptedForRFT: false,
    };
  }
  const total = Math.max(1, Number(grade.totalOps || 0));
  const passed = Math.max(0, Math.min(total, Number(grade.passedOps || 0)));
  const format = 0.1;
  const accuracy = Math.round((0.7 * (passed / total)) * 10000) / 10000;
  const hasDrift = (grade.driftWarnings || []).length > 0;
  const drift = hasDrift ? -0.3 : 0.2;
  const patchPenalty = -Math.min(0.2, (grade.patchErrors || []).length * 0.05);
  const reward = Math.max(-0.5, Math.min(1.0, Math.round((format + accuracy + drift + patchPenalty) * 10000) / 10000));
  const acceptedForRFT = Boolean(grade.allPassed && grade.parseOk && !hasDrift && (grade.patchErrors || []).length === 0);
  return {
    reward,
    breakdown: { format, accuracy, drift, patchPenalty },
    acceptedForRFT,
  };
}
