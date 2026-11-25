# Changelog

All notable changes to **MVU-SeedFuzz** will be documented in this file.

## [0.1.0] - 2026-11-26

### Added
- **Deterministic Seed Engine (`src/engine.mjs`)**: Mulberry32 PRNG sampling over an indexed, conflict-aware mutable variable operator vector.
- **Reverse-Oracle Pipeline**: AI-A pure RP story synthesis with token/anti-leak gate + AI-B blind variable update evaluation + deterministic code oracle grading + untouched-domain drift detection.
- **Framework-Agnostic Hooks**: Optional `parseModelOutput` and `applyUpdate` preset hooks enabling non-JSONPatch variable systems (`_.set`, YAML blocks, custom XML/regex DSLs).
- **Zero-Dependency CLI & Dual Providers (`src/cli.mjs`, `src/providers.mjs`)**: Built-in OpenAI-compatible Chat Completions & Google Gemini REST API support with configurable concurrency and Markdown/JSON vulnerability heatmap output.
- **AI Agent Native Guide (`AGENTS.md`)**: Step-by-step adaptation protocol for Antigravity, Claude Code, Cursor, and Codex.
- **Reference Demo Presets**: `presets/minimal-rpg.mjs` (12 operators + derived-state oracle) and `presets/sillytavern-card-template.mjs` (SillyTavern card worldbook/monitor extraction helpers).
- **Automated Test Suite & CI**: Zero-cost unit tests (`npm test`), oracle self-check (`npm run selftest`), and GitHub Actions CI across Node 18 / 20 / 22.
