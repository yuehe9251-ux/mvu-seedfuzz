# MVU-SeedFuzz

> **面向 SillyTavern / MVU / AI RP 变量卡的“种子驱动逆向真值模糊测试”框架**  
> **Seed-Driven Reverse-Oracle Variable Fuzzing & Vulnerability Heatmap for AI RP Character Cards**

[中文说明](./README.md) · [English README](./README_EN.md) · [MIT License](./LICENSE)

---

## 适用场景与定位

> [!IMPORTANT]
> **专为复杂变量框架打造（Complex Stateful Variable Frameworks）**  
> 如果你的角色卡只有 2~3 个简单数值（如单纯 HP / 好感度），直接人工试聊即可。  
> `mvu-seedfuzz` 专门解决**大型复杂状态机 / 复杂 MVU 变量框架**（15~60+ 跨域变量、引用式装备库、负属性 Debuff、自动抽税/经验倍率/跨日营收等后台监视器联动、严格 Zod Schema 校验）在多变量并发与弱模型下的隐蔽翻车问题。

> [!NOTE]
> **示例声明**：本仓库内置的 `presets/minimal-rpg.mjs`、`presets/sillytavern-card-template.mjs` 与 `examples/sample-heatmap.md` **仅为作者用于演示机制的个人示例框架**，其字段名（如 `/player/hp`、`/bag/gold`）与世界书示例并非固定标准——**请务必按下方指南替换为你自己的变量框架与规则！**

> 🤖 **给 AI Agent（Antigravity / Claude Code / Cursor / Codex）用户的快捷通道**：  
> 仓库根目录已内置专门写给 Agent 读的接入规范 [**`AGENTS.md`**](./AGENTS.md)。你可以直接把本仓库与你的角色卡放在一起，对 Agent 说：  
> *“阅读 `AGENTS.md`，帮我把我的角色卡接入 `mvu-seedfuzz`，先跑通 `selftest` 再盲测 10 个种子出热力图。”*

---

## 为什么做这个工具？

开发带有复杂状态栏 / MVU（MagVarUpdate）变量系统的 AI RP 角色卡时，作者通常面临三大痛点：
1. **手测覆盖面极窄**：人工跑团来回只测“打怪、掉钱、买药、加好感”那几条老路，**多变量并发冲突**（如“跨日资产收益 + 公会 10% 抽税 + 负属性 Debuff + 引用式换装”同时发生）几乎永远测不到。
2. **模型幻觉难以定位**：改了一版世界书规则或换了一个便宜弱模型（如 Flash / FlashLite），到底哪一条变量规则最容易写错、漏写或覆写父容器？纯靠体感完全说不清。
3. **传统 AI 裁判本身也会犯错**：`SimUser + LLM-as-a-Judge` 不仅慢、贵，而且 AI 裁判经常自己算错倍率或放过静默漂移。

**MVU-SeedFuzz 的核心反转思路（Reverse-Oracle Fuzzing）**：  
**不再先写剧情再猜答案——而是把所有可变项排成一列，用确定性种子随机抽组合算出精确真值，让 AI-A 把真值“反译”成纯自然语言剧情，再拿纯剧情去盲测 AI-B 填表，最后由你自己的真实代码状态机（Oracle）精确裁判！**

```text
[全变量原子算子列 OPS[0..N]] + [互斥约束组]
           │
           ▼  确定性 PRNG (Mulberry32, seed) 抽取 k 项合法并发变动
   [预期 Patch] ──(真实状态机/监视器)──▶ [精确真值 Expected State]
           │
           ▼  AI-A 逆向反推（严禁夹带私货 / 漏数字 / 泄标签）
   [纯自然语言 RP 剧情] ──(关键词+防泄露前置门禁)──▶ 校验失败自动重写
           │
           ▼  AI-B 盲测（只看真实世界书规则 + 初始状态 + 剧情正文）
   [模型输出 <UpdateVariable>] ──(真实状态机/监视器裁判)──▶ [实得 Actual State]
           │
           ▼  三档自动判分（精确值 / 派生联动值 / 结构合规）+ 未触及域漂移拦截
   [分变量脆弱度热力图 heatmap.md] + [100% 可复现翻车种子 seed=xxxx]
```

---

## 核心特性

- **零第三方依赖**：纯 Node.js（`>= 18`）ESM 实现，无需 `npm install` 即可开箱运行。
- **100% 确定性种子回归**：同一 `seed` 永久生成完全相同的变量组合与数值，修完世界书规则或监视器后重跑同一批 `seed`，直接对比命中率提升。
- **真实代码状态机裁判（Zero-Hallucination Oracle）**：支持挂载角色卡自己的 `monitor.js` / 派生结算脚本，自动校验“经验倍率、公会抽税、自动升级、跨日收益”等联动结果，甚至能在自检阶段顺手抓出监视器本身的代码 Bug。
- **防脏题干 + 防静默漂移双护栏**：
  - 前置门禁确保 AI-A 反推剧情没有遗漏关键数字/专名、没有泄露 `<JSONPatch>` 标签；
  - 漂移守卫拦截模型“覆写父容器导致原有好友/装备库清空”或“擅自篡改未提及字段”。
- **双模运行**：
  - **外部 API 命令行模式**：原生支持任意 OpenAI 兼容端点（DeepSeek / OpenRouter / 本地 Ollama / 中转站）及 Google Gemini 原生 REST API，支持并发压测；
  - **Agent 并发工作流模式**：附带 `workflows/antigravity_fuzz.py`，可在支持多 Agent 工作流的桌面端直接零外部 Key 并发试跑。

---

## 30 秒快速上手

### 1. 运行内置自检（零 API 消耗）
验证内置 `minimal-rpg` 预设的 12 个算子 + 10 组随机并发组合种子 + 漂移检测全部 100% 通过：
```bash
npm test
npm run selftest
```

### 2. 查看算子列 & 预览单个种子生成的反推剧情提示词
```bash
node src/cli.mjs list-ops --preset presets/minimal-rpg.mjs
node src/cli.mjs gen --preset presets/minimal-rpg.mjs --seed 1001 --k 4
```

### 3. 接入你的 API 跑 10 种子并发盲测并输出热力图
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
> 也支持环境变量 `FUZZ_API_URL` / `FUZZ_API_KEY` / `FUZZ_MODEL`，以及直接传入 Google Gemini 原生 `generateContent` 地址。

---

## 如何更换为你自己的变量框架（完全解耦）

本工具把**测试引擎（`src/engine.mjs`）**与**具体变量框架（`presets/*.mjs`）**彻底拆离。内置的 `minimal-rpg.mjs` 只是个人示例，你可以按以下 4 步替换为**任意复杂变量框架**（不限于 JSONPatch，也支持传统 `_.set`、YAML、自定义正则状态栏）：

### 第 1 步：新建你自己的预设文件
复制 [presets/sillytavern-card-template.mjs](./presets/sillytavern-card-template.mjs) 为 `presets/my-framework.mjs`，按需实现以下接口：

| 接口字段 | 必填 | 如何替换为你的框架 |
| :--- | :---: | :--- |
| `createBaseState()` | 必填 | 换成你框架的初始完整 `stat_data`（建议放齐各类示例条目，方便第 1 轮直接测试增删改） |
| `loadRules(options)` | 必填 | 返回你要测的真实规则文本（可用内置 `extractWorldbookRulesFromCard('./my-card.json')` 直读酒馆卡世界书，或直接读你的 `.md`/`.txt` 规则文件） |
| `operators` | 必填 | 把你的全部可变项排成原子算子数组，每项写明 `conflicts`（互斥组）、`storyFact`、`requiredTokens`、`expectedPatches`、`verify()` |
| `runOracle(state, turn)` | 可选 | 挂载你自己的后台监视器 / 派生属性结算脚本（可用 `loadEmbeddedMonitor` 直载酒馆助手脚本）；若框架无后台自动计算，直接省略即可 |
| `checkDrift(act, base, picked)` | 推荐 | 写几条“未触及域防漂移”断言（如：未要求改好友时绝不能清空好友表） |
| `parseModelOutput(rawText)` | 可选 | **更换非 JSONPatch 框架的关键钩子！** 默认解析 `<UpdateVariable><JSONPatch>[...]`；若你的框架用 `_.set(...)`、YAML 或自定义正则标签，覆写此函数返回 `{ ok, patches, error }` 即可 |
| `applyUpdate(base, parsed)` | 可选 | 配合 `parseModelOutput` 使用，定义如何把你自己的指令应用到 `base` 上，返回 `{ statData, applied, errors }` |

### 第 2 步：先跑零 Token 自检门禁
```bash
node src/cli.mjs selftest --preset presets/my-framework.mjs
```
确保全部单算子 + 10 组随机组合种子 **100% 自洽通过**后再调大模型（顺手还能提前测出你监视器脚本里的代码 Bug）。

### 第 3 步：指定 `--preset` 开跑压测
```bash
node src/cli.mjs run --preset presets/my-framework.mjs --card ./my-card.json --seeds 1001..1015 --k 4 --api-url ... --model ... --md-out heatmap.md
```

### 第 4 步：懒人法 —— 直接交给 AI Agent 自动适配
如果你不想手写 30 个算子，直接让你的 AI Coding Agent 阅读根目录的 [**`AGENTS.md`**](./AGENTS.md)，它会自动扫描你的角色卡 Schema 与世界书、生成 `presets/my-framework.mjs`、跑通 `selftest` 并交付脆弱度热力图。

---

## 输出热力图样例

详见 [examples/sample-heatmap.md](./examples/sample-heatmap.md) —— 谁容易错、哪个种子翻车、具体期望值 vs 实得值一目了然：

| Domain | Operator ID | Variable Mutation | Pass/Total | Hit Rate | Failing Seeds & Diagnostics |
| :--- | :--- | :--- | :---: | :---: | :--- |
| World | `world_time_regen` | Advance time +15m (auto regen) | 1/2 | 🟡 50% | seed=1008(expected hp=470, got 420) |
| Economy | `gold_gain_taxed` | Earn Gold (10% auto guild tax) | 3/3 | 🟢 100% | — |
| Gear | `equip_swap_ref` | Swap weapon via repo key | 4/4 | 🟢 100% | — |

---

## 开源协议

本项目基于 [MIT License](./LICENSE) 开源，欢迎任意角色卡作者、预设作者与酒馆开发者自由使用、二次开发与 PR 贡献预设模板！
