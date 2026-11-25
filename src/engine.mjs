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
  const storyPrompt = [
    `You are a strict reverse-oracle RP story writer for preset "${preset.name}" (SEED=${seed}).`,
    `Write a natural, immersive 200-380 word RP story turn in the language of the facts below that embeds EVERY listed mutation cleanly.`,
    ``,
    `[HARD RULES — ANY VIOLATION INVALIDATES THE TEST]`,
    `1. Every single fact, exact number, item/skill/quest/NPC name, and duration in the list MUST appear naturally in the story prose.`,
    `2. NEVER invent extra side effects: no unrequested free items, no extra gold/EXP/affection, no extra time skips, no unrequested HP/AP changes.`,
    `3. Output ONLY pure story prose. NEVER output JSON, XML, <UpdateVariable>, <JSONPatch>, or code fences.`,
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
    vectorIndices: picked.map((p) => p.opIndex),
    picked,
    baseStatData,
    expectedPatches,
    expectedStatData,
    storyPrompt,
  };
}

/** Gate check on AI-A's synthesized story: catch missing numbers/names or leaked patch tags BEFORE testing AI-B. */
export function verifyGeneratedStory(testCase, storyText) {
  const txt = String(storyText || '');
  const missing = [];
  for (const op of testCase.picked) {
    for (const tok of op.requiredTokens) {
      if (!txt.includes(tok)) missing.push({ opId: op.id, token: tok });
    }
  }
  const hasLeakTag = /<UpdateVariable|<JSONPatch|\{"op"\s*:/i.test(txt);
  return {
    ok: missing.length === 0 && !hasLeakTag && txt.trim().length >= 60,
    missing,
    hasLeakTag,
    length: txt.trim().length,
  };
}

/** Build blind prompt for AI-B (target model): ONLY real card rules + initial state + story prose. */
export function buildBlindUpdaterPrompt(preset, testCase, storyText, options = {}) {
  const rules = typeof preset.loadRules === 'function' ? preset.loadRules(options) : '';
  const stateForPrompt = typeof preset.sanitizeStateForPrompt === 'function'
    ? preset.sanitizeStateForPrompt(deepClone(testCase.baseStatData))
    : deepClone(testCase.baseStatData);

  return [
    `You are an AI RP / SillyTavern MVU state-update engine.`,
    `Strictly follow the rules below to convert the new RP story turn into precise JSONPatch updates against the current stat_data.`,
    `Output ONLY an <UpdateVariable><JSONPatch>[...]</JSONPatch></UpdateVariable> block (valid JSON array, no story recap).`,
    ``,
    `=== VARIABLE UPDATE RULES ===`,
    rules,
    ``,
    `=== CURRENT stat_data ===`,
    JSON.stringify(stateForPrompt),
    ``,
    `=== NEW RP STORY TURN ===`,
    storyText,
  ].join('\n');
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

  const title = meta.title || 'MVU-SeedFuzz Variable Vulnerability Heatmap';
  const lines = [
    `# ${title}`,
    ``,
    meta.model ? `- Target Model: **${meta.model}**` : null,
    `- Seeds Tested: **${results.length}** (All-Pass Seeds: **${fullPassSeeds}/${results.length}**)`,
    `- Atomic Variable Hit Rate: **${totalPass}/${totalOps}** (**${hitRatePct}%**)`,
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
