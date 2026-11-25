# Using MVU-SeedFuzz for LLM Post-Training (RFT / RLVR / GRPO)

> **Core Insight**: The exact same reverse-oracle pipeline (`Deterministic State Machine + Seeded Mutation Vector -> Natural Language Story Synthesis -> Blind Structured Update -> Deterministic Code Verifier`) is a zero-annotation **synthetic data & Reinforcement Learning with Verifiable Rewards (RLVR)** environment for training small/mid-size LLMs on long-context state tracking and strict structured patching.

---

## 1. Pipeline Mapping to Post-Training

| MVU-SeedFuzz Stage | Post-Training Equivalent | Advantage |
| :--- | :--- | :--- |
| **Seeded Conflict-Free Operator Vector + Real Monitor** | Procedural Environment & Ground-Truth Oracle | Infinite unique multi-mutation problems with 100% deterministic answers |
| **AI-A Pure Prose Synthesis + Token/Anti-Leak Gate** | Inverse Problem Synthesis | Hides exact structured deltas inside natural prose + optional 50k+ char distractor history |
| **AI-B Blind Rollout** | Policy Rollout (`<think>` + `<UpdateVariable>`) | Forces genuine long-context rule recall & JSONPatch precision |
| **Real Code Verifier (`gradeUpdaterOutput` + `computeVerifiableReward`)** | Verifiable Reward `R ∈ [-0.5, 1.0]` | Zero LLM-as-a-judge bias, millisecond scoring, fine-grained partial credit |
| **Vulnerability Heatmap** | Automatic Curriculum Learning | Upsample low-hit-rate operators on the next training epoch |

---

## 2. Deterministic Reward Function (`computeVerifiableReward`)

Exported from `src/engine.mjs`:
- **Parse failure (`!parseOk`)**: `-0.5`
- **Valid structured output (`parseOk`)**: `+0.1`
- **Exact oracle accuracy**: `+0.7 * (passedOps / totalOps)`
- **Untouched-domain drift check**: `+0.2` if zero drift, `-0.3` if drift warnings triggered
- **Patch application errors**: `-min(0.2, patchErrors.length * 0.05)`
- **RFT Acceptance (`acceptedForRFT`)**: `true` iff `allPassed && parseOk && driftWarnings.length === 0 && patchErrors.length === 0`

---

## 3. Exporting Training Datasets (`export-rlvr`)

### Mode A: Rejection-Sampling Fine-Tuning (RFT / SFT)
Collect rollouts from a strong teacher model (`deepseek-flash`, `gemini-3.8-flash`, etc.) and export **only 100% verified, zero-drift trajectories** to fine-tune a local 7B/8B/14B model:

```bash
node src/cli.mjs export-rlvr \
  --results-file ./runs/results.json \
  --prompt-dir ./runs \
  --output-dir ./runs \
  --out ./datasets/rft_sft.jsonl \
  --rft-only
```

### Mode B: Full Rollouts with Continuous Reward (GRPO / RLVR)
Keep both passing and failing rollouts alongside their exact `reward` and `rewardBreakdown` for preference optimization or online RLVR verification harnesses:

```bash
node src/cli.mjs export-rlvr \
  --results-file ./runs/results.json \
  --prompt-dir ./runs \
  --output-dir ./runs \
  --out ./datasets/rlvr_all.jsonl
```

Each JSONL line contains:
```json
{
  "seed": 7001,
  "isLongContext": false,
  "prompt": "...",
  "completion": "<UpdateVariable>...</UpdateVariable>",
  "reward": 1.0,
  "rewardBreakdown": { "format": 0.1, "accuracy": 0.7, "drift": 0.2, "patchPenalty": 0 },
  "acceptedForRFT": true,
  "passedOps": 4,
  "totalOps": 4,
  "driftWarnings": []
}
```

---

## 4. Ecosystem Reference Notes (Upstream GitHub Frameworks)

While MVU-SeedFuzz fills the missing **reverse-oracle state-tracking environment + verifier** layer, you can plug its `gradeUpdaterOutput` / `computeVerifiableReward` directly into mature open-source RLVR / GRPO trainers on GitHub:

- **HuggingFace TRL (`GRPOTrainer`)**: Production-standard GRPO trainer supporting custom Python reward functions (call `node src/cli.mjs grade` or a persistent Node sidecar verifier).
- **`karinazad/nano-rlvr`**: Minimal single-GPU REINFORCE/GRPO implementation (~150 lines) ideal for prototyping custom verifiable reward loops.
- **`areal-project/AReaL`**: Scalable asynchronous RL infrastructure bridging LLM training with stateful agent environments.
- **Open-ended RLVR research (`SpyRL` / `RLSVR` / `RLVR-World`)**: Demonstrates converting narrative/interactive environments into deterministic verifiable reward proxies.

---

## 5. Two Critical Guardrails When Training

1. **Prevent Style Overfitting (AI-A Prose Diversity)**: During evaluation, clear prose is desirable; during training data generation, diversify AI-A's writing style (dialogue-heavy, implicit cues, literary prose, noisy multi-turn chatter, varied schemas) so the student model learns semantic reasoning rather than keyword templates.
2. **Prevent Reward Hacking**: Ensure your preset verifier allows equivalent valid state transitions (e.g., reasonable minor clock advances or explicit rule exemptions like tiered-NPC auto-management) so RL does not over-penalize sensible model behavior.
