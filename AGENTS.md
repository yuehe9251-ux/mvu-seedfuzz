# AGENTS.md — AI Agent Onboarding & Adaptation Guide for `mvu-seedfuzz`

This document is written specifically for **AI Coding Agents** (Antigravity, Claude Code, Cursor, Codex, etc.) tasked with adapting a user's **complex AI RP / SillyTavern / MVU variable framework** to `mvu-seedfuzz` and running automated seed-driven reverse-oracle fuzzing.

---

## 1. When This Tool Applies (Target Scope)

`mvu-seedfuzz` is designed specifically for **complex stateful variable frameworks**, such as:
- Character cards / RP engines with **15–60+ mutable variables** across multiple coupled domains (character stats, inventory stacks, reference-based gear repos, buffs/debuffs with signed modifiers, companions, guilds/taxes, familiars, quests, calendars, spatial coordinates).
- Frameworks with **derived calculations or background monitor scripts** (auto level-up, tax routing, EXP multipliers, time-driven regeneration, cross-day asset revenue).
- Strict schema / JSONPatch / `_.set` / custom XML or YAML variable protocols where regressions or weak-model hallucinations are hard to catch manually.

> **Important Notice on Built-in Presets**:  
> `presets/minimal-rpg.mjs` and `presets/sillytavern-card-template.mjs` are **author-provided illustrative demo frameworks only**. NEVER assume the user's card uses the same field names, paths, or patch syntax! Always inspect the user's actual card/schema/rules first and create a brand-new preset file `presets/<user-card>.mjs`.

---

## 2. Standard 5-Step Agent Workflow (Follow Strictly)

### Step 1 — Audit the User's Actual Variable Framework (Read-Only)
Locate and inspect the user's source files:
1. **State Schema & Initial State**: e.g., `schema.js`, `initvar`, or `stat_data` snapshot inside the card `.json`.
2. **Variable Update Rules**: e.g., `[mvu_update]*` worldbook entries, system prompts, or format specs (note whether the framework uses **RFC-6902 JSONPatch + `delta`**, **Classic `_.set`/`_.assign`**, **YAML/JSON state blocks**, or **custom regex tags**).
3. **Background Monitor / Derived State Engine** (if any): e.g., `monitor.js`, TavernHelper scripts, or external stat calculators.

### Step 2 — Author `presets/<user-card>.mjs`
Create a dedicated preset exporting a default object conforming to the `mvu-seedfuzz` preset contract:

| Property | Required | Purpose |
| :--- | :---: | :--- |
| `name` | Yes | Short identifier for reports |
| `createBaseState()` | Yes | Returns a rich baseline `stat_data` containing pre-populated entities so all domains can be mutated on Turn 1 |
| `loadRules(options)` | Yes | Returns the exact live rule text injected into AI-B (blind updater). Never include test hints! |
| `operators` | Yes | Flat array of atomic mutation operators (`id`, `domain`, `name`, `conflicts[]`, `build(rng, baseState)`) |
| `runOracle(state, turnIndex)` | Optional | Runs the card's real monitor / derived-stat engine (`turnIndex = 1` initializes baseline snapshot; `turnIndex = 2` settles post-patch turn). Omit or return `state` if the card has no background monitor |
| `formatStateSummary(baseState)` | Recommended | Concise human-readable state summary injected into AI-A (reverse story writer) |
| `sanitizeStateForPrompt(state)` | Optional | Strips internal oracle/audit metadata before injecting `stat_data` into AI-B |
| `checkDrift(actual, base, picked)` | Recommended | Returns warning strings if untouched critical containers (companions, gear repo, currency) were accidentally altered or wiped |
| `parseModelOutput(rawText)` | Optional | **Swap this if the user's framework does NOT use `<JSONPatch>`!** Return `{ ok, patches, error }` |
| `applyUpdate(baseState, parsedData)` | Optional | **Swap this alongside `parseModelOutput` for non-JSONPatch frameworks** (e.g., `_.set`, YAML merge, custom DSL). Return `{ statData, applied, errors }` |

#### Operator Authoring Rules (Prevent False Positives!)
1. **Conflict Groups (`conflicts`)**: Tag mutually incompatible operators with shared strings (e.g., `['time_regen', 'hp']` if advancing time triggers auto HP regen; `['gold']` if two operators both mutate currency).
2. **Clean `storyFact` for AI-A**: Explicitly state every exact number, entity name, key (if required by the card), and duration; forbid extra gifts or extra time skips.
3. **Minimal `requiredTokens`**: Include only critical digits/names that MUST appear in AI-A's prose so `verifyGeneratedStory` catches omissions without rejecting natural phrasing.
4. **3-Tier `verify(actual, expected, base)`**:
   - **Exact fields** (currency, counts, timestamps, signed debuffs): strict `===`;
   - **Oracle-derived fields** (auto-taxed vault, auto-multiplied EXP, auto-regen HP): compare `actual` against `expected` (both computed through `runOracle`);
   - **Creative/structural fields** (newly generated item/skill/quest/NPC): verify schema compliance, valid key prefix, required non-empty fields, and numeric bounds rather than exact flavor-text strings.

### Step 3 — Mandatory Zero-Token Oracle Gate (`selftest`)
**NEVER call LLM APIs before `selftest` passes 100%!**
```bash
node src/cli.mjs selftest --preset presets/<user-card>.mjs
```
- Confirms every single operator (`N/N`) passes against its own `expectedPatches` through the real `runOracle`;
- Confirms 10 random multi-operator combo seeds (`1001..1010`) pass with zero conflict bugs and zero false drift warnings.
- **Bonus**: If `runOracle` crashes during `selftest`, you have just discovered a real bug in the user's monitor/engine code — report and fix it first!

### Step 4 — Run Blind Fuzzing (Pick Either Mode)
- **Mode A (External API CLI — OpenAI-compatible or Gemini REST)**:
  ```bash
  node src/cli.mjs run --preset presets/<user-card>.mjs --seeds 1001..1015 --k 4 --concurrency 3 --api-url <URL> --api-key <KEY> --model <TARGET_MODEL> --md-out heatmap.md
  ```
- **Mode B (Native Multi-Agent Workflow — Zero External Key)**:
  Invoke `workflows/antigravity_fuzz.py` with `preset`, `seeds`, `k`, `story_model`, and `target_model`.

### Step 5 — Diagnose Heatmap, Fix Root Cause, Re-Run Failing Seeds
1. Inspect every operator with hit rate `< 100%` in `heatmap.md`:
   - First inspect `story_<seed>.txt` to verify AI-A did not omit facts or invent extra side effects (if it did, tighten `storyFact` / `requiredTokens`);
   - Next inspect `updater_out_<seed>.txt`: distinguish **verifier too strict** vs **worldbook wording ambiguous** vs **real monitor/schema bug**;
2. Apply minimal, targeted fixes to the user's worldbook rules or monitor script;
3. Re-run the **exact same failing `seed`s** to prove the fix raised hit rate without causing regressions elsewhere.

---

## 3. Hard Guardrails for Agents
- NEVER leak `expectedPatches`, `expectedStatData`, or `verify` logic into AI-B's blind prompt (`buildBlindUpdaterPrompt`).
- NEVER modify `src/engine.mjs` to hardcode card-specific Chinese/English field names; keep all card-specific logic isolated inside `presets/<user-card>.mjs`.
- Always preserve failing `seed` numbers in your report to the user as permanent regression anchors.
