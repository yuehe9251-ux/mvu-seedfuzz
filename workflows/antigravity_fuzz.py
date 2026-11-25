"""
mvu-seedfuzz · Antigravity Native Parallel Workflow Runner (Zero External API Key)

Usage inside Antigravity `run_workflow`:
  Args = {
    "preset": "presets/minimal-rpg.mjs",
    "seeds": [1001, 1002, 1003, 1004, 1005, 1006],
    "long_seeds": [1005, 1006],
    "long_context_chars": 55000,
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
long_seeds = set(args.get("long_seeds", []))
long_context_chars = int(args.get("long_context_chars", 55000))
chunk_size = int(args.get("chunk_size", 26000))
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
    ctx_chars = long_context_chars if s in long_seeds else 0
    chk = json.loads(
        run_cli(["check-story", "--preset", preset, "--seed", str(s), "--k", str(k), "--context-chars", str(ctx_chars), "--story-file", story_path, "--prompt-out", prompt_path])
    )
    if not chk.get("ok"):
        fix_msg = f"Previous draft failed gate (missing={json.dumps(chk.get('missing', []), ensure_ascii=False)}, hasLeakTag={chk.get('hasLeakTag')}). Rewrite pure story prose only."
        story = await writer(fix_msg, {"type": "string"})
        with open(story_path, "w", encoding="utf-8") as f:
            f.write(story)
        chk = json.loads(
            run_cli(["check-story", "--preset", preset, "--seed", str(s), "--k", str(k), "--context-chars", str(ctx_chars), "--story-file", story_path, "--prompt-out", prompt_path])
        )
    del writer
    with open(prompt_path, "r", encoding="utf-8") as f:
        blind_prompt = f.read()
    return {"seed": s, "is_long": s in long_seeds, "prompt_chars": len(blind_prompt), "story_ok": chk.get("ok", False), "blind_prompt": blind_prompt}


story_bundles = await parallel(cases, synthesize_story)

phase(f"3. Blind Variable Update Evaluation in Parallel (AI-B: {target_model})")


async def eval_updater(bundle):
    s = bundle["seed"]
    raw_prompt = bundle["blind_prompt"]
    final_tail = (
        "\n\n[CRITICAL OUTPUT REQUIREMENTS]\n"
        "1. NEVER call read_file, run_command, or any external filesystem/shell tools.\n"
        "2. Pass the COMPLETE `<UpdateVariable><JSONPatch>[...]</JSONPatch></UpdateVariable>` block verbatim as your `finish` tool result string. NEVER return a confirmation summary sentence like 'Successfully generated'."
    )
    tag = "LONG" if bundle["is_long"] else "STD"
    # Auto-chunk long prompts into a real multi-turn conversation so zero bytes are truncated by single-turn message limits
    if len(raw_prompt) > 42000 and "=== CURRENT stat_data ===" in raw_prompt:
        head_part, tail_part = raw_prompt.split("=== CURRENT stat_data ===", 1)
        tail_turn = "=== CURRENT stat_data ===" + tail_part + final_tail
        chunks = [head_part[i:i + chunk_size] for i in range(0, len(head_part), chunk_size)]
        updater = agent(
            "You are an AI RP / SillyTavern MVU state-update engine. NEVER call external filesystem or shell tools. Earlier turns supply rules and already-settled prior RP history; reply 'OK' via finish for each chunk. On the final turn containing CURRENT stat_data and NEW RP STORY TURN, emit ONLY the complete <UpdateVariable><JSONPatch>[...]</JSONPatch></UpdateVariable> verbatim via finish.",
            role=f"AI-B({target_model}/{tag}) seed={s}",
            model=target_model,
        )
        for idx, ck in enumerate(chunks, 1):
            await updater(
                f"[CONTEXT CHUNK {idx}/{len(chunks)} — rules & settled prior history, DO NOT output patches yet]\n{ck}\n\nRemember this context, do not call external tools, and call finish with 'OK'.",
                {"type": "string"},
            )
        out = await updater(
            "[FINAL TURN — EVALUATE NOW] Below is the latest stat_data and the ONLY new RP story turn to settle (do NOT re-apply prior settled history):\n\n"
            + tail_turn,
            {"type": "string"},
        )
        del updater
    else:
        out = await agent(
            raw_prompt + final_tail,
            schema={"type": "string"},
            role=f"AI-B({target_model}/{tag}) seed={s}",
            model=target_model,
        )
    out_path = os.path.join(out_dir, f"updater_out_{s}.txt")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(out or "")
    return {"seed": s, "is_long": bundle["is_long"], "prompt_chars": bundle["prompt_chars"], "story_ok": bundle["story_ok"], "out_path": out_path}


updater_bundles = await parallel(story_bundles, eval_updater)

phase("4. Deterministic Oracle Grading & Heatmap Report")
grades = []
for ub in updater_bundles:
    s = ub["seed"]
    g = json.loads(run_cli(["grade", "--preset", preset, "--seed", str(s), "--k", str(k), "--output-file", ub["out_path"]]))
    g["storyValid"] = ub["story_ok"]
    g["isLongContext"] = ub["is_long"]
    g["promptChars"] = ub["prompt_chars"]
    grades.append(g)
    mode_tag = f"LONG({ub['prompt_chars']}c)" if ub["is_long"] else f"STD({ub['prompt_chars']}c)"
    status = "PASS" if g["allPassed"] else f"FAIL ({g['passedOps']}/{g['totalOps']})"
    log(f"SEED={s} [{mode_tag}] -> {status} | drift={len(g['driftWarnings'])}")

std_g = [g for g in grades if not g["isLongContext"]]
lng_g = [g for g in grades if g["isLongContext"]]
if lng_g:
    def _grp(arr):
        if not arr:
            return "0/0"
        ok_s = sum(1 for x in arr if x["allPassed"])
        ok_o = sum(x["passedOps"] for x in arr)
        tot_o = sum(x["totalOps"] for x in arr)
        pct = round(ok_o * 100.0 / max(1, tot_o), 1)
        return f"seeds={ok_s}/{len(arr)}, ops={ok_o}/{tot_o} ({pct}%)"
    log(f"=== Group Comparison === Standard: {_grp(std_g)} | Long-Context: {_grp(lng_g)}")

results_path = os.path.join(out_dir, "results.json")
md_path = os.path.join(out_dir, "heatmap.md")
with open(results_path, "w", encoding="utf-8") as f:
    json.dump(grades, f, ensure_ascii=False, indent=2)

print(run_cli(["report", "--results-file", results_path, "--model", target_model, "--md-out", md_path]))
