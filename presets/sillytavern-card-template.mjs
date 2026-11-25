/**
 * mvu-seedfuzz · SillyTavern MVU Character Card Adapter Template
 *
 * Copy this file to adapt ANY SillyTavern `.json` character card (with embedded
 * `[mvu_update]` worldbook entries & optional TavernHelper monitor script):
 *
 *   node src/cli.mjs selftest --preset presets/sillytavern-card-template.mjs
 *   node src/cli.mjs run --preset presets/sillytavern-card-template.mjs --card ./my-card.json --seeds 1001..1010 ...
 */
import fs from 'fs';
import vm from 'vm';
import minimalPreset from './minimal-rpg.mjs';

/**
 * Helper: extract all `[mvu_update]*` worldbook entries directly from a SillyTavern V2/V3 card JSON.
 */
export function extractWorldbookRulesFromCard(cardPath, prefix = '[mvu_update]') {
  if (!cardPath || !fs.existsSync(cardPath)) return minimalPreset.loadRules();
  const card = JSON.parse(fs.readFileSync(cardPath, 'utf8'));
  const entries = card?.data?.character_book?.entries || [];
  return entries
    .filter((e) => e && e.enabled !== false && String(e.comment || '').includes(prefix))
    .map((e) => `=== ${e.comment} ===\n${e.content}`)
    .join('\n\n');
}

/**
 * Helper: load a TavernHelper monitor script embedded in a SillyTavern card into a sandboxed Node vm.
 * Customize the export hook string to match your monitor script's function names.
 */
export function loadEmbeddedMonitor(cardPath, scriptName, exportNames = ['syncDerivedStats']) {
  const card = JSON.parse(fs.readFileSync(cardPath, 'utf8'));
  const scripts = card?.data?.extensions?.tavern_helper?.scripts || [];
  const entry = scripts.find((s) => s.name === scriptName);
  if (!entry || !entry.content) throw new Error(`Script "${scriptName}" not found in ${cardPath}`);
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(
    entry.content
      .replace(/await\s+waitGlobalInitialized\([^)]*\);\s*/, '')
      .replace(/if \(typeof eventOn[\s\S]*$/, `globalThis.__ORACLE = { ${exportNames.join(', ')} };`),
    ctx
  );
  return ctx.__ORACLE;
}

export default {
  ...minimalPreset,
  name: 'sillytavern-card-template',
  loadRules(options = {}) {
    return extractWorldbookRulesFromCard(options.card);
  },
};
