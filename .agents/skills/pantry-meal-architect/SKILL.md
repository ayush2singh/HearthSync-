---
name: pantry-meal-architect
description: Plans waste-reducing household meals by cross-referencing expiring pantry inventory, family allergies, and macro targets. Use when asked what to cook, meal planning, or expiring groceries.
---

# Pantry Meal Architect Agent Skill

<!--
  Specification-Compliant Agent Skill (.agents/skills/ Open Standard).
  Implements 3-stage progressive disclosure:
  1. Discovery: ~100-token YAML frontmatter.
  2. Activation: This concise procedural instructions file (<500 lines).
  3. Execution: On-demand lookup of references/macro-substitution-matrix.md.
-->

## Purpose & Scope
The `pantry-meal-architect` orchestrates autonomous, zero-waste meal planning for ambient smart displays (Amazon Echo Show 21). When a user asks "What can I cook tonight?" or "Use up our expiring groceries", this skill audits perishable items, applies household allergy guardrails, and renders multimodal recipe cards paired with concise voice readouts.

---

## 4-Stage Procedural Execution Workflow

```
┌────────────────────────────────────────────────────────┐
│ Stage 1: Context & Inventory Hydration                 │
│ • Read hearth://household/memory                       │
│ • Call sync_pantry_inventory(action: "list")           │
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────┴────────────────────────────┐
│ Stage 2: Allergen & Macro Matrix Evaluation            │
│ • Filter expiring items (isExpiringUrgent: true, <48h) │
│ • Cross-reference references/macro-substitution-matrix │
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────┴────────────────────────────┐
│ Stage 3: Meal Plan Generation & Recipe Selection       │
│ • Call plan_expiry_meals(householdId, dietaryTags...)  │
│ • Prioritize meals utilizing expiring perishable stock │
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────┴────────────────────────────┐
│ Stage 4: Multimodal Voice & Display Synthesis          │
│ • Spoken response: STRICTLY ≤2 warm sentences          │
│ • Visual response: Render interactive recipe cards     │
└────────────────────────────────────────────────────────┘
```

---

### Stage 1: Context & Inventory Hydration
1. Fetch the active household profile from the MCP resource:
   ```json
   {
     "method": "resources/read",
     "params": { "uri": "hearth://household/memory" }
   }
   ```
   Extract `allergies`, `dietaryTags`, `budgetRemainingUsd`, and `macroTargets`.
2. Inspect current pantry stock via the MCP tool:
   ```json
   {
     "method": "tools/call",
     "params": {
       "name": "sync_pantry_inventory",
       "arguments": {
         "householdId": "hh-alexa-kitchen-01",
         "action": "list"
       }
     }
   }
   ```
   Identify all items where `isExpiringUrgent == true` (less than 48 hours until expiry).

---

### Stage 2: Allergen & Macro Evaluation
1. Never suggest recipes that contain items in the household's `allergies` list.
2. If a traditional recipe calls for an allergen (e.g. Pine Nuts or Dairy Cream), consult:
   `references/macro-substitution-matrix.md`
3. Apply the strict 4-tier resolution hierarchy:
   - **Tier 1 (Hard Safety):** Big-9 allergens (e.g. Tree Nuts -> Pumpkin Seeds).
   - **Tier 2 (Ethical Diet):** Vegetarian, Vegan, Kosher, or Halal rules.
   - **Tier 3 (Zero-Waste):** Maximize use of items expiring within 48 hours.
   - **Tier 4 (Budget & Macros):** Maximize protein per dollar under `budgetRemainingUsd`.

---

### Stage 3: Meal Plan Generation
Invoke the meal planning tool with active constraints:
```json
{
  "method": "tools/call",
  "params": {
    "name": "plan_expiry_meals",
    "arguments": {
      "householdId": "hh-alexa-kitchen-01",
      "dietaryTags": ["Vegetarian", "High-Protein"],
      "maxPrepMinutes": 30,
      "servings": 2
    }
  }
}
```

Verify that each returned meal card specifies:
- `title` & `description`
- `usesExpiringItems`: Must cite at least one urgent perishable item.
- `nutritionPerServing`: Protein, Calories, Carbs, Fat.
- `timers`: Structured burner steps for Echo Show display.

---

### Stage 4: Multimodal Voice & Screen Output Rules

Smart displays suffer from cognitive overload if Alexa speaks long ingredient lists aloud. Adhere strictly to these ambient voice rules:

1. **Spoken Voice Constraint (STRICT):**
   - Output **no more than 2 warm, natural sentences**.
   - Example: *"I found 2 high-protein meals that use up your expiring spinach and paneer, both under your weekly budget. Would you like Saag Paneer or a Whipped Greek Yogurt Bowl?"*
2. **Visual Screen Display:**
   - Display touch-interactive cards showing recipe photos, cook time badges, and missing grocery counts.
   - Attach actionable touch buttons:
     - `[Stage Smart Cart]` -> Transitions to `smart-cart-checkout` skill.
     - `[Start Prep Timers]` -> Invokes `stage_kitchen_timers` tool.
