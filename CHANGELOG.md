# Changelog

All notable changes to **MVU-SeedFuzz** will be documented in this file.

## [0.2.0] - 2026-11-26

### Added
- **A/B Endpoint & Relay Audit (`mvu-seedfuzz compare`)**: Evaluates two API endpoints (e.g., Official Direct API vs Third-Party Relay / Candidate Model) on **byte-for-byte identical frozen blind prompts** (`--story-dir`, default `--temperature 0`) across both Standard and Long-Context seeds.
- **Automated Objective Diagnostics (`buildCompareReport`)**: Computes side-by-side Standard/Long-Context hit rates, JSON parse failure rates, untouched-domain drift, avg/P95 latency, and multi-provider prefix cache hit rates, emitting clear signals (`LONG_CONTEXT_TRUNCATION_SUSPECT`, `ACCURACY_DEGRADATION_SUSPECT`, `FORMAT_INSTABILITY_SUSPECT`, `CACHE_BYPASS_SUSPECT`, or `CONSISTENT_WITH_BASELINE`) plus a per-seed divergence table.
- **Multi-Provider Cache & Latency Telemetry (`callLLMWithMeta` in `src/providers.mjs`)**: Automatically normalizes prompt/completion/prefix-cache tokens across DeepSeek (`prompt_cache_hit_tokens`), OpenAI (`prompt_tokens_details.cached_tokens`), Anthropic (`cache_read_input_tokens`), and Gemini (`cachedContentTokenCount`).
- **Local Mock HTTP End-to-End Test**: Expanded `test/self-check.mjs` to 12 tests, including a live local dual-server A/B test verifying detection of silent long-context truncation and cache stripping.

## [0.1.2] - 2026-11-26

### Added
- **Long-Context Stress Testing (`--context-chars`, `--long-seeds`)**: Deterministically injects realistic settled prior-turn RP history packed with numerical distractors (old prices, old damage, old potion uses) between the variable rules and `CURRENT stat_data` to measure long-context rule recall & historical-number bleed-through resistance.
- **Custom History Filler Hook (`preset.buildHistoryFiller(seed, targetChars)`)**: Allows any card preset to supply world-accurate prior-turn distractor prose.
- **Multi-Turn Zero-Truncation Chunking (`workflows/antigravity_fuzz.py`)**: Automatically splits prompts >42k chars into stateful multi-turn sessions (`chunk_size=26000`) so ultra-long contexts (~90k+ chars) never hit single-turn input truncation ceilings.
- **Standard vs Long-Context Comparison Metrics**: `buildHeatmapReport` and `workflows/antigravity_fuzz.py` automatically emit side-by-side Standard vs Long-Context hit rates whenever long-context seeds are present.
- **Expanded Self-Check Suite**: Added 3 deterministic unit tests covering history filler determinism, prompt section ordering, custom filler hooks, and mixed-context heatmap reporting (10/10 passing).

## [0.1.1] - 2026-11-26

### Added
- Added AI-Agent-native operational guide (`AGENTS.md`), explicit complex-framework scope notes, and clear instructions on replacing the included minimal demo preset with any user variable system.

## [0.1.0] - 2026-11-26

### Added
- **Deterministic Seed Engine (`src/engine.mjs`)**: Mulberry32 PRNG sampling over an indexed, conflict-aware mutable variable operator vector.
- **Reverse-Oracle Pipeline**: AI-A pure RP story synthesis with token/anti-leak gate + AI-B blind variable update evaluation + deterministic code oracle grading + untouched-domain drift detection.
- **Framework-Agnostic Hooks**: Optional `parseModelOutput` and `applyUpdate` preset hooks enabling non-JSONPatch variable systems (`_.set`, YAML blocks, custom XML/regex DSLs).
- **Zero-Dependency CLI & Dual Providers (`src/cli.mjs`, `src/providers.mjs`)**: Built-in OpenAI-compatible Chat Completions & Google Gemini REST API support with configurable concurrency and Markdown/JSON vulnerability heatmap output.
- **AI Agent Native Guide (`AGENTS.md`)**: Step-by-step adaptation protocol for Antigravity, Claude Code, Cursor, and Codex.
- **Reference Demo Presets**: `presets/minimal-rpg.mjs` (12 operators + derived-state oracle) and `presets/sillytavern-card-template.mjs` (SillyTavern card worldbook/monitor extraction helpers).
- **Automated Test Suite & CI**: Zero-cost unit tests (`npm test`), oracle self-check (`npm run selftest`), and GitHub Actions CI across Node 18 / 20 / 22.
