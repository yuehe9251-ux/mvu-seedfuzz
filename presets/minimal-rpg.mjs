/**
 * mvu-seedfuzz · Minimal RPG Reference Preset (12 Atomic Operators + Real Derived-State Oracle)
 *
 * Demonstrates all key capabilities out of the box with zero external files:
 *  - Deterministic conflict-aware operator sampling
 *  - Real code oracle (automatic 10% guild tax on gold gain, auto level-up on EXP threshold, auto HP/MP regen when time advances >= 10m)
 *  - Untouched-domain drift guard (catches parent-object overwrite bugs!)
 */
import { deepClone, pickOne } from '../src/engine.mjs';

const MINIMAL_RULES = `
[Minimal RPG MVU Variable Update Rules]
1. Use RFC-6902 JSONPatch paths (slash-separated, no "stat_data" prefix).
2. Numeric increments/decrements MUST use {"op":"delta","path":"/...", "value": N}:
   - /player/hp, /player/mp, /player/exp, /bag/gold, /bag/items/<name>/qty, /companions/<id>/affection
3. NEVER overwrite parent containers (/companions, /bag/items, /bag/gear_repo) — always use "add" on the exact child path.
4. Background Oracle Auto-Settlement (DO NOT manually calculate!):
   - Guild Tax: When player earns gold via delta +N on /bag/gold, the background monitor automatically routes 10% to /guild/vault_gold and keeps 90% in /bag/gold. Write ONLY raw +N to /bag/gold!
   - Level-Up: When /player/exp reaches 1000, the background monitor automatically increments /player/level and carries over remainder EXP. Write ONLY raw EXP delta!
   - Natural Regen: When /world/time_min advances by >= 10 minutes, the background monitor automatically restores +50 HP and refills MP to max (100). Write ONLY the new /world/time_min!
5. Reference-based Equipment: /player/equipped/weapon stores ONLY the key inside /bag/gear_repo (e.g., "gear_silver_blade").
6. Debuffs allow negative attribute values inside /player/statuses/<id>/mods (e.g., {"agi": -2}).
`.trim();

function createBaseState() {
  return {
    _oracle: { prevGold: 1000, prevTimeMin: 860 },
    world: { location: 'Oakridge Market', time_min: 860, safe_zone: false },
    player: {
      name: 'Aria',
      level: 5,
      exp: 750,
      hp: 420,
      max_hp: 500,
      mp: 70,
      max_mp: 100,
      equipped: { weapon: 'gear_iron_sword' },
      statuses: {},
    },
    guild: { name: 'Silver Wing', tax_pct: 10, vault_gold: 2000 },
    bag: {
      gold: 1000,
      items: {
        HealthPotion: { name: 'HealthPotion', qty: 3, effect: 'Restore 150 HP' },
      },
      gear_repo: {
        gear_iron_sword: { name: 'Iron Sword', atk: 24, durability: 50 },
        gear_silver_blade: { name: 'Silver Blade', atk: 38, durability: 60 },
      },
    },
    quests: {
      WolfHunt: { name: 'WolfHunt', progress: '2/5', status: 'active', reward: '300 EXP, 400 Gold' },
    },
    companions: {
      npc_lyra: { name: 'Lyra', affection: 40, present: true, is_friend: true },
    },
  };
}

/** Deterministic reference oracle (simulates SillyTavern monitor post-processing). */
function runOracle(rawState, turnIndex) {
  const s = deepClone(rawState);
  if (!s._oracle) s._oracle = { prevGold: s.bag.gold, prevTimeMin: s.world.time_min };
  if (turnIndex === 1) {
    s._oracle.prevGold = s.bag.gold;
    s._oracle.prevTimeMin = s.world.time_min;
    return s;
  }

  // 1) Automatic 10% guild tax on positive gold income
  const goldDiff = Number(s.bag.gold || 0) - Number(s._oracle.prevGold || 0);
  if (goldDiff > 0 && s.guild?.tax_pct > 0) {
    const tax = Math.floor((goldDiff * s.guild.tax_pct) / 100);
    s.bag.gold -= tax;
    s.guild.vault_gold = Number(s.guild.vault_gold || 0) + tax;
  }

  // 2) Automatic level-up when EXP >= 1000
  while (Number(s.player.exp || 0) >= 1000) {
    s.player.exp -= 1000;
    s.player.level += 1;
    s.player.max_hp += 50;
  }

  // 3) Automatic natural regen when time advances >= 10 minutes
  const dt = Number(s.world.time_min || 0) - Number(s._oracle.prevTimeMin || 0);
  if (dt >= 10) {
    s.player.hp = Math.min(s.player.max_hp, Number(s.player.hp || 0) + 50);
    s.player.mp = s.player.max_mp;
  }

  s._oracle.prevGold = s.bag.gold;
  s._oracle.prevTimeMin = s.world.time_min;
  return s;
}

const operators = [
  {
    id: 'player_hp_damage',
    domain: 'Player',
    name: 'Take HP damage',
    conflicts: ['hp', 'time_regen'],
    build(rng) {
      const dmg = pickOne(rng, [65, 90, 120, 145]);
      return {
        storyFact: `A dart grazes Aria, dealing exactly ${dmg} HP damage (/player/hp -${dmg}).`,
        requiredTokens: [String(dmg)],
        expectedPatches: [{ op: 'delta', path: '/player/hp', value: -dmg }],
        verify: (a, e) => ({ ok: a.player.hp === e.player.hp, detail: `expected hp=${e.player.hp}, got ${a.player.hp}` }),
      };
    },
  },
  {
    id: 'player_mp_spend',
    domain: 'Player',
    name: 'Spend MP casting skill',
    conflicts: ['mp', 'time_regen'],
    build(rng) {
      const cost = pickOne(rng, [15, 20, 25]);
      return {
        storyFact: `Aria casts a quick flash-step skill, spending ${cost} MP (takes only a few seconds, no time skip).`,
        requiredTokens: [String(cost), 'MP'],
        expectedPatches: [{ op: 'delta', path: '/player/mp', value: -cost }],
        verify: (a, e) => ({ ok: a.player.mp === e.player.mp, detail: `expected mp=${e.player.mp}, got ${a.player.mp}` }),
      };
    },
  },
  {
    id: 'player_exp_levelup',
    domain: 'Player',
    name: 'Earn EXP triggering auto level-up',
    conflicts: ['exp'],
    build(rng) {
      const exp = pickOne(rng, [300, 350, 420]);
      return {
        storyFact: `Aria defeats a stray hound and earns ${exp} base EXP (write raw +${exp} delta to /player/exp; level-up is auto-calculated).`,
        requiredTokens: [String(exp), 'EXP'],
        expectedPatches: [{ op: 'delta', path: '/player/exp', value: exp }],
        verify: (a, e) => ({
          ok: a.player.level === e.player.level && a.player.exp === e.player.exp,
          detail: `expected Lv.${e.player.level} exp=${e.player.exp}, got Lv.${a.player.level} exp=${a.player.exp}`,
        }),
      };
    },
  },
  {
    id: 'gold_gain_taxed',
    domain: 'Economy',
    name: 'Earn Gold (10% auto guild tax)',
    conflicts: ['gold'],
    build(rng) {
      const gain = pickOne(rng, [400, 500, 800]);
      return {
        storyFact: `Aria collects a bounty reward of ${gain} Gold (write raw +${gain} delta to /bag/gold; 10% guild tax is deducted automatically).`,
        requiredTokens: [String(gain), 'Gold'],
        expectedPatches: [{ op: 'delta', path: '/bag/gold', value: gain }],
        verify: (a, e) => ({
          ok: a.bag.gold === e.bag.gold && a.guild.vault_gold === e.guild.vault_gold,
          detail: `expected bag=${e.bag.gold}/vault=${e.guild.vault_gold}, got bag=${a.bag.gold}/vault=${a.guild.vault_gold}`,
        }),
      };
    },
  },
  {
    id: 'gold_spend',
    domain: 'Economy',
    name: 'Spend Gold',
    conflicts: ['gold'],
    build(rng) {
      const cost = pickOne(rng, [120, 200, 260]);
      return {
        storyFact: `Aria pays ${cost} Gold at the notice board for an intel fee (/bag/gold -${cost}).`,
        requiredTokens: [String(cost), 'Gold'],
        expectedPatches: [{ op: 'delta', path: '/bag/gold', value: -cost }],
        verify: (a, e) => ({ ok: a.bag.gold === e.bag.gold, detail: `expected gold=${e.bag.gold}, got ${a.bag.gold}` }),
      };
    },
  },
  {
    id: 'item_potion_merge',
    domain: 'Inventory',
    name: 'Merge into existing item stack',
    conflicts: ['potion'],
    build(rng) {
      const qty = pickOne(rng, [2, 3, 4]);
      return {
        storyFact: `A quartermaster hands Aria ${qty} free HealthPotion bottles (merge into existing HealthPotion stack, no gold spent).`,
        requiredTokens: ['HealthPotion', String(qty)],
        expectedPatches: [{ op: 'delta', path: '/bag/items/HealthPotion/qty', value: qty }],
        verify: (a, e) => {
          const keys = Object.keys(a.bag?.items || {}).filter((k) => /HealthPotion/i.test(k));
          const q = a.bag?.items?.HealthPotion?.qty;
          return { ok: keys.length === 1 && q === e.bag.items.HealthPotion.qty, detail: `expected 1 stack qty=${e.bag.items.HealthPotion.qty}, got stacks=${keys.length} qty=${q}` };
        },
      };
    },
  },
  {
    id: 'item_new_add',
    domain: 'Inventory',
    name: 'Add brand-new item',
    conflicts: ['item_new'],
    build() {
      return {
        storyFact: `Aria loots 2 AntidoteCrystal items from a crate (effect: Cure all poison statuses).`,
        requiredTokens: ['AntidoteCrystal', '2'],
        expectedPatches: [{ op: 'add', path: '/bag/items/AntidoteCrystal', value: { name: 'AntidoteCrystal', qty: 2, effect: 'Cure all poison statuses' } }],
        verify: (a) => {
          const hit = Object.values(a.bag?.items || {}).find((v) => v && /AntidoteCrystal/i.test(v.name || ''));
          return { ok: !!hit && Number(hit.qty) === 2, detail: hit ? `qty=${hit.qty}` : 'AntidoteCrystal missing' };
        },
      };
    },
  },
  {
    id: 'equip_swap_ref',
    domain: 'Gear',
    name: 'Swap weapon via repo key',
    conflicts: ['weapon'],
    build() {
      return {
        storyFact: `Aria unequips Iron Sword and equips Silver Blade (key: gear_silver_blade) from her gear_repo.`,
        requiredTokens: ['Silver Blade'],
        expectedPatches: [{ op: 'replace', path: '/player/equipped/weapon', value: 'gear_silver_blade' }],
        verify: (a) => ({ ok: a.player?.equipped?.weapon === 'gear_silver_blade', detail: `got weapon=${JSON.stringify(a.player?.equipped?.weapon)}` }),
      };
    },
  },
  {
    id: 'debuff_neg_agi',
    domain: 'Status',
    name: 'Inflict negative-AGI debuff',
    conflicts: ['debuff'],
    build() {
      return {
        storyFact: `Aria steps into a FrostSnare trap, suffering debuff "FrostSnare" (agi -2 for 2 turns).`,
        requiredTokens: ['FrostSnare', '-2', '2'],
        expectedPatches: [{ op: 'add', path: '/player/statuses/debuff_frost', value: { name: 'FrostSnare', turns: 2, mods: { agi: -2 } } }],
        verify: (a) => {
          const hit = Object.values(a.player?.statuses || {}).find((v) => v && /FrostSnare/i.test(v.name || ''));
          return { ok: !!hit && Number(hit.mods?.agi) === -2, detail: hit ? `agi=${hit.mods?.agi}` : 'FrostSnare missing' };
        },
      };
    },
  },
  {
    id: 'companion_affection',
    domain: 'Social',
    name: 'Increase companion affection',
    conflicts: ['lyra_aff'],
    build(rng) {
      const gain = pickOne(rng, [4, 6, 8]);
      return {
        storyFact: `After a warm conversation, Lyra (npc_lyra) smiles brightly; her affection increases by +${gain}.`,
        requiredTokens: ['Lyra', String(gain)],
        expectedPatches: [{ op: 'delta', path: '/companions/npc_lyra/affection', value: gain }],
        verify: (a, e) => ({ ok: a.companions?.npc_lyra?.affection === e.companions.npc_lyra.affection, detail: `expected ${e.companions.npc_lyra.affection}, got ${a.companions?.npc_lyra?.affection}` }),
      };
    },
  },
  {
    id: 'quest_progress',
    domain: 'World',
    name: 'Advance quest progress',
    conflicts: ['quest'],
    build() {
      return {
        storyFact: `Having slain another timber wolf, quest "WolfHunt" updates its progress to "3/5".`,
        requiredTokens: ['WolfHunt', '3/5'],
        expectedPatches: [{ op: 'replace', path: '/quests/WolfHunt/progress', value: '3/5' }],
        verify: (a) => ({ ok: String(a.quests?.WolfHunt?.progress || '').includes('3/5'), detail: `got progress="${a.quests?.WolfHunt?.progress}"` }),
      };
    },
  },
  {
    id: 'world_time_regen',
    domain: 'World',
    name: 'Advance time +15m (auto regen)',
    conflicts: ['time_regen', 'hp', 'mp'],
    build() {
      return {
        storyFact: `Aria rests at the fountain for 15 minutes (world time_min advances from 860 to 875; natural HP/MP regen is auto-calculated).`,
        requiredTokens: ['15', '875'],
        expectedPatches: [{ op: 'replace', path: '/world/time_min', value: 875 }],
        verify: (a, e) => ({
          ok: a.world?.time_min === 875 && a.player.hp === e.player.hp && a.player.mp === e.player.mp,
          detail: `expected time=875 hp=${e.player.hp} mp=${e.player.mp}, got time=${a.world?.time_min} hp=${a.player.hp} mp=${a.player.mp}`,
        }),
      };
    },
  },
];

export default {
  name: 'minimal-rpg',
  createBaseState,
  runOracle,
  loadRules: () => MINIMAL_RULES,
  sanitizeStateForPrompt(s) {
    delete s._oracle;
    return s;
  },
  formatStateSummary(s) {
    return `- Player: ${s.player.name} (Lv.${s.player.level}, EXP ${s.player.exp}/1000, HP ${s.player.hp}/${s.player.max_hp}, MP ${s.player.mp}/${s.player.max_mp}, Gold ${s.bag.gold}, Weapon ${s.player.equipped.weapon}, world time_min ${s.world.time_min})\n- Guild: ${s.guild.name} (${s.guild.tax_pct}% tax, Vault ${s.guild.vault_gold})\n- Companion: Lyra (npc_lyra, affection ${s.companions.npc_lyra.affection}, present)`;
  },
  checkDrift(actual, base, picked) {
    const warns = [];
    const conflicts = new Set(picked.flatMap((p) => p.conflicts || []));
    if (!conflicts.has('gold') && actual.bag?.gold !== base.bag.gold) {
      warns.push(`Unrequested gold drift: ${base.bag.gold} -> ${actual.bag?.gold}`);
    }
    if (!actual.companions?.npc_lyra) {
      warns.push('CRITICAL: companion npc_lyra deleted (possible parent overwrite on /companions)');
    }
    if (Object.keys(actual.bag?.gear_repo || {}).length < 2) {
      warns.push('CRITICAL: gear_repo entries lost (possible parent overwrite on /bag/gear_repo)');
    }
    return warns;
  },
  operators,
};
