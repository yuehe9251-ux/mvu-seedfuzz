# MVU-SeedFuzz Variable Vulnerability Heatmap (Sample Output)

- Target Model: **gemini-2.5-flash-lite**
- Seeds Tested: **6** (All-Pass Seeds: **4/6**)
- Atomic Variable Hit Rate: **22/24** (**91.7%**)

| Domain | Operator ID | Variable Mutation | Pass/Total | Hit Rate | Failing Seeds & Diagnostics |
| :--- | :--- | :--- | :---: | :---: | :--- |
| Spatial | `map_spatial_move` | 3D map spatial move command | 0/2 | 🔴 0% | seed=1003(missing spatial target rule entry in blind context); seed=1005(used landmark ID instead of region name) |
| Familiar | `fam_heart_crystal` | Familiar lethal guard -> Heart state | 2/2 | 🟢 100% | — |
| Skills | `skill_weapon_lv_up` | Weapon proficiency +1 | 2/2 | 🟢 100% | — |
| Inventory | `item_potion_buy` | Merge into existing potion stack | 2/2 | 🟢 100% | — |
| Player | `me_safe_zone_enter` | Enter safe zone flag | 2/2 | 🟢 100% | — |
| Gear | `equip_swap_ref` | Reference-based weapon swap | 2/2 | 🟢 100% | — |
| Economy | `guild_vault_donate` | Donate currency to guild vault | 1/1 | 🟢 100% | — |
| Status | `buff_positive_add` | Add percentage buff with duration | 1/1 | 🟢 100% | — |
| Social | `friend_leave_scene` | Companion leaves scene without deletion | 1/1 | 🟢 100% | — |
| Combat | `enemy_hp_damage` | Active enemy HP delta | 1/1 | 🟢 100% | — |

> **Actionable takeaway**: Every core RPG/economy/gear/familiar variable hit **100%** even on `flash-lite`, while the heatmap immediately pinpointed the single blind spot (`map_spatial_move`) with exact reproducible seeds (`seed=1003`, `seed=1005`).
