# MVU-SeedFuzz

> **Seed-Driven Reverse-Oracle Variable Fuzzing & Vulnerability Heatmap for SillyTavern / MVU / AI RP Character Cards**

[English](./README_EN.md) · [中文文档](./README.md) · [MIT License](./LICENSE)

---

## Target Scope & Example Disclaimer

> [!IMPORTANT]
> **Built for Complex Stateful Variable Frameworks**  
> If your RP card only tracks 2–3 flat counters (e.g., HP & Affection), manual testing is enough.  
> `mvu-seedfuzz` is engineered for **complex variable frameworks** (15–60+ coupled variables, reference-based equipment repos, signed debuffs, background monitor derivations such as guild taxes / EXP multipliers / cross-day revenue, and strict schema validation) where concurrent multi-rule interactions break weak or fast LLMs.

> [!NOTE]
> **Personal Demo Notice**: The bundled `presets/minimal-rpg.mjs`, `presets/sillytavern-card-template.mjs`, and `examples/sample-heatmap.md` are **personal illustrative examples only**—their schemas and paths are NOT fixed standards. Always replace them with your own framework preset following the guide below.

> 🤖 **AI Agent Fast-Track (`AGENTS.md`)**:  
> This repository ships with a dedicated [**`AGENTS.md`**](./AGENTS.md) written specifically for coding agents (Antigravity, Claude Code, Cursor, Codex). Point your agent at your card + `AGENTS.md` and ask it to generate a custom preset, pass `selftest`, and run a fuzz sweep automatically.

---

## Motivation

Building stateful AI Roleplay (RP) character cards (SillyTavern + MagVarUpdate / MVU / TavernHelper) suffers from three classic QA problems:
1. **Tiny manual test coverage**: Hand-written playtests only cover common flows, rarely hitting tricky concurrent state combinations (e.g., *guild tax + auto level-up + negative-AGI debuff + reference-based weapon swap* in the same turn).
2. **Blind rule tuning**: When you trim worldbook prompts or test cheaper/faster models (e.g., Flash / Flash-Lite / local models), you have no quantitative view of *which exact variable rule* breaks first.
3. **Noisy AI judges**: `LLM-as-a-Judge` evaluators hallucinate arithmetic and miss silent state drift (such as overwriting a parent container and wiping existing companions/inventory).

**MVU-SeedFuzz flips the testing pipeline (Reverse-Oracle Fuzzing):**
Instead of writing stories first and guessing answers, it flattens all mutable state variables into an indexed operator vector, uses a deterministic PRNG `seed` to sample valid concurrent mutations, computes exact ground truth via your real code oracle, asks **AI-A** to reverse-synthesize pure natural-language RP prose, blind-tests **AI-B** on ONLY the prose + real card rules, and grades the resulting `<UpdateVariable><JSONPatch>` deterministically!

```text
[Indexed Mutable-Variable Vector OPS[0..N]] + [Conflict Groups]
           │
           ▼  Deterministic PRNG (Mulberry32, seed) samples k compatible mutations
   [Expected Patches] ──(Real Monitor/State Oracle)──▶ [Exact Expected State]
           │
           ▼  AI-A Reverse Story Writer (strict no-extra-side-effects prompt)
   [Pure RP Story Prose] ──(Token & Anti-Leak Gate)──▶ Auto-retry on omission
           │
           ▼  AI-B Blind Evaluation (real card rules + initial state + story ONLY)
   [Model <UpdateVariable>] ──(Real Monitor/State Oracle)──▶ [Actual State]
           │
           ▼  Per-Operator Exact/Derived/Structural Grading + Drift Detection
   [Per-Variable Vulnerability Heatmap] + [100% Reproducible Failing Seeds]
```

---

## Key Features

- **Zero dependencies**: Pure Node.js (`>= 18`) ESM — works immediately with no `npm install`.
- **100% deterministic regression seeds**: Every failing case maps to an integer `seed`. Edit your worldbook rules, re-run the same seeds, and measure the exact delta in hit rate.
- **Real code oracle (Zero-Hallucination Grading)**: Plug in your card's actual derived-stat/monitor script so derived rules (tax splits, EXP multipliers, cross-day asset revenue, natural regen) are verified mathematically — often uncovering real bugs in your monitor script itself during `selftest`.
- **Two-layer anti-noise guardrails**:
  - Pre-gate checks AI-A's synthesized story for missing numbers/proper nouns or leaked JSONPatch tags before AI-B is ever graded;
  - Drift guard checks untouched domains for accidental parent-container overwrites.
- **Dual execution modes**:
  - Standalone CLI supporting any OpenAI-compatible Chat Completions endpoint or Google Gemini native REST endpoint (`--concurrency N`);
  - Optional multi-agent workflow template (`workflows/antigravity_fuzz.py`).

---

## Quick Start

### 1. Run zero-cost unit & oracle self-tests
```bash
npm test
npm run selftest
```

### 2. Inspect operators & generate a deterministic seed prompt
```bash
node src/cli.mjs list-ops --preset presets/minimal-rpg.mjs
node src/cli.mjs gen --preset presets/minimal-rpg.mjs --seed 1001 --k 4
```

### 3. Run automated blind fuzzing & generate a vulnerability heatmap
```bash
node src/cli.mjs run \
  --preset presets/minimal-rpg.mjs \
  --seeds 1001..1010 \
  --k 4 \
  --concurrency 3 \
  --api-url https://api.openai.com/v1/chat/completions \
  --api-key YOUR_API_KEY \
  --model gemini-2.5-flash-lite \
  --story-model gemini-2.5-flash \
  --md-out heatmap.md
```

---

## How to Replace with Your Own Variable Framework

The core engine (`src/engine.mjs`) is **100% decoupled** from the demo presets. You can plug in **any** complex variable framework—JSONPatch MVU, classic `_.set` MagVarUpdate, YAML status blocks, or custom regex/XML DSLs:

1. **Create `presets/my-framework.mjs`** (start from [presets/sillytavern-card-template.mjs](./presets/sillytavern-card-template.mjs)):
   - `createBaseState()` — your card's baseline `stat_data`;
   - `loadRules(options)` — your live worldbook / prompt rules (helper `extractWorldbookRulesFromCard` reads SillyTavern `.json` cards directly);
   - `operators[]` — your indexed mutable variable operators (`conflicts`, `storyFact`, `requiredTokens`, `expectedPatches`, `verify`);
   - `runOracle(state, turn)` *(optional)* — your real background monitor / derived-stat script (`loadEmbeddedMonitor` helper included);
   - `checkDrift(actual, base, picked)` *(recommended)* — guards untouched containers against accidental overwrites;
   - `parseModelOutput(rawText)` & `applyUpdate(base, parsed)` *(optional)* — **override these two hooks to support ANY non-JSONPatch variable syntax** (`_.set`, YAML, XML, custom DSL).
2. **Verify zero-token oracle self-consistency first**:
   ```bash
   node src/cli.mjs selftest --preset presets/my-framework.mjs
   ```
3. **Run blind fuzzing with `--preset presets/my-framework.mjs`**, or simply let your AI coding agent handle steps 1–3 automatically using [**`AGENTS.md`**](./AGENTS.md)!

---

## License

[MIT](./LICENSE)
