"""
mvu-seedfuzz · Antigravity Native Parallel Workflow Runner (Zero External API Key)

Usage inside Antigravity `run_workflow`:
  Args = {
    "preset": "presets/minimal-rpg.mjs",
    "seeds": [1001, 1002, 1003, 1004, 1005, 1006],
    "k": 4,
    "story_model": "flash",
    "target_model": "flash_lite",
    "repo_dir": "/abs/path/to/mvu-seedfuzz",
    "out_dir": "/abs/path/to/output"
  }
"""
import json
import os
import shutil
import subprocess

repo_dir = args.get("repo_dir", os.getcwd())
preset = args.get("preset", os.path.join(repo_dir, "presets", "minimal-rpg.mjs"))
seeds = args.get("seeds", [1001, 1002, 1003, 1004, 1005, 1006])
k = int(args.get("k", 4))
story_model = args.get("story_model", "flash")
target_model = args.get("target_model", "flash_lite")
out_dir = args.get("out_dir", os.path.join(repo_dir, ".runs", "latest"))
node_bin = args.get("node_bin") or shutil.which("node.exe") or shutil.which("node") or "node"
cli_path = os.path.join(repo_dir, "src", "cli.mjs")
os.makedirs(out_dir, exist_ok=True)


def run_cli(cli_args):
    proc = subprocess.run(
        [node_bin, cli_path] + cli_args,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    return proc.stdout


phase("1. Generate Deterministic Seed Cases")
cases = []
for s in seeds:
    case_path = os.path.join(out_dir, f"case_{s}.json")
    run_cli(["gen", "--preset", preset, "--seed", str(s), "--k", str(k), "--out", case_path])
    with open(case_path, "r", encoding="utf-8") as f:
        tc = json.load(f)
    cases.append(tc)
    log(f"SEED={s} -> [{', '.join(p['id'] for p in tc['picked'])}]")

phase("2. Reverse-Synthesize RP Stories in Parallel (AI-A)")


async def synthesize_story(tc):
    s = tc["seed"]
    writer = agent(
        "You are a strict RP story writer for reverse-oracle testing. Output ONLY pure story prose with every listed fact and number embedded naturally. Never output JSON/XML or invent extra items/gold/EXP/time.",
        role=f"AI-A Story seed={s}",
        model=story_model,
    )
    story = await writer(tc["storyPrompt"], {"type": "string"})
    story_path = os.path.join(out_dir, f"story_{s}.txt")
    prompt_path = os.path.join(out_dir, f"blind_prompt_{s}.txt")
    with open(story_path, "w", encoding="utf-8") as f:
        f.write(story)
    chk = json.loads(
        run_cli(["check-story", "--preset", preset, "--seed", str(s), "--k", str(k), "--story-file", story_path, "--prompt-out", prompt_path])
    )
    if not chk.get("ok"):
        fix_msg = f"Previous draft failed gate (missing={json.dumps(chk.get('missing', []), ensure_ascii=False)}, hasLeakTag={chk.get('hasLeakTag')}). Rewrite pure story prose only."
        story = await writer(fix_msg, {"type": "string"})
        with open(story_path, "w", encoding="utf-8") as f:
            f.write(story)
        chk = json.loads(
            run_cli(["check-story", "--preset", preset, "--seed", str(s), "--k", str(k), "--story-file", story_path, "--prompt-out", prompt_path])
        )
    del writer
    with open(prompt_path, "r", encoding="utf-8") as f:
        blind_prompt = f.read()
    return {"seed": s, "story_ok": chk.get("ok", False), "blind_prompt": blind_prompt}


story_bundles = await parallel(cases, synthesize_story)

phase(f"3. Blind Variable Update Evaluation in Parallel (AI-B: {target_model})")


async def eval_updater(bundle):
    s = bundle["seed"]
    strict_prompt = (
        bundle["blind_prompt"]
        + "\n\n[CRITICAL OUTPUT REQUIREMENT] Pass the COMPLETE `<UpdateVariable><JSONPatch>[...]</JSONPatch></UpdateVariable>` block verbatim as your `finish` tool result string. NEVER return a confirmation summary sentence like 'Successfully generated'."
    )
    out = await agent(
        strict_prompt,
        schema={"type": "string"},
        role=f"AI-B Updater({target_model}) seed={s}",
        model=target_model,
    )
    out_path = os.path.join(out_dir, f"updater_out_{s}.txt")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(out or "")
    return {"seed": s, "story_ok": bundle["story_ok"], "out_path": out_path}


updater_bundles = await parallel(story_bundles, eval_updater)

phase("4. Deterministic Oracle Grading & Heatmap Report")
grades = []
for ub in updater_bundles:
    s = ub["seed"]
    g = json.loads(run_cli(["grade", "--preset", preset, "--seed", str(s), "--k", str(k), "--output-file", ub["out_path"]]))
    g["storyValid"] = ub["story_ok"]
    grades.append(g)
    log(f"SEED={s} -> {'PASS' if g['allPassed'] else f'FAIL ({g[\"passedOps\"]}/{g[\"totalOps\"]})'} | drift={len(g['driftWarnings'])}")

results_path = os.path.join(out_dir, "results.json")
md_path = os.path.join(out_dir, "heatmap.md")
with open(results_path, "w", encoding="utf-8") as f:
    json.dump(grades, f, ensure_ascii=False, indent=2)

print(run_cli(["report", "--results-file", results_path, "--model", target_model, "--md-out", md_path]))
