---
name: smart-cart-checkout
description: Diffs recipe requirements against household pantry inventory, executes 4-tier allergen and unit-price ingredient substitutions, renders the interactive ui://hearth/cart-carousel MCP App, and enforces guardrailed transactional checkout. Use when staging grocery carts, comparing unit prices, swapping allergens or over-budget items, or authorizing order checkout on Alexa+ and Echo Show devices.
license: MIT
compatibility: Works with Alexa+ Streamable HTTP MCP Orchestrator (2025-11-25 and 2026-07-28), Amazon Bedrock AgentCore, Strands Agents SDK, and any Agent Skills (.agents/skills/) compatible host.
metadata:
  author: ayush-singh
  version: "2.0.0"
  track: alexa-plus
  mcp-transport: streamable-http
  progressive-disclosure-stage1-tokens: "52"
  allowed-tools: "sync_pantry_inventory optimize_smart_cart authorize_checkout stage_kitchen_timers"
---

# Smart Cart Checkout Agent Skill

Coordinates autonomous grocery cart staging, deterministic unit-price and allergen optimization, interactive MCP App rendering (`ui://hearth/cart-carousel`), and transactionally guardrailed checkout for Alexa+ smart displays (Echo Show 21 and Echo Show 15).

---

## When to Use
- The user approves a meal plan or recipe card and says "Stage smart cart", "Add missing ingredients to my cart", or "Order groceries for these meals".
- A recipe contains ingredients that conflict with household allergies, dietary rules, or the weekly grocery budget cap (`budgetCapUsd`).
- The user interacts with the `ui://hearth/cart-carousel` widget on the Echo Show screen to toggle 1-tap brand/ingredient swaps or adjust quantities.
- The user explicitly confirms an order via voice ("Alexa, confirm checkout") or touch (`CONFIRMED_TOUCH_TAP`) and wants prep timers staged.

---

## 4-Stage Transactional Checkout Pipeline

| Stage | Pipeline Phase | Core Execution & MCP Primitives | Target SLA & Guardrail |
| :--- | :--- | :--- | :--- |
| **Stage 1** | **Pantry Reconciliation (Diffing)** | Read `hearth://household/memory` and call `sync_pantry_inventory(action="list")` with mirrored `Mcp-Param-HouseholdId`. | <180ms lookup; exclude in-stock items and deduct partial stock. |
| **Stage 2** | **4-Tier Unit-Price & Allergen Optimization** | Call `optimize_smart_cart` with `Accept: application/json, text/event-stream` to run `scripts/optimize_unit_price.py` and stream `notifications/progress`. | 100% Big-9 allergen elimination; `totalCostUsd <= budgetCapUsd`. |
| **Stage 3** | **Interactive MCP App Mounting** | Attach `ui://hearth/cart-carousel` (`@modelcontextprotocol/ext-apps`) and speak a ≤2-sentence voice summary (<35 words). | Zero voice price-list bloat; 1-tap visual swap controls enabled. |
| **Stage 4** | **Guardrailed Checkout & Timer Staging** | Verify explicit confirmation token and budget ceiling, call `authorize_checkout`, persist order to memory, and invoke `stage_kitchen_timers`. | Reject unconfirmed or over-budget orders (-32602); issue idempotent order ID. |

---

## Step-by-Step Execution Workflow

### Stage 1: Pantry Reconciliation & Unit-Normalized Diffing

1. **Read Household Memory & Active Inventory**
   - Fetch `hearth://household/memory` via `resources/read` to load `dietaryRestrictions`, `allergies`, `macroGoals`, and `weeklyBudgetCapUsd`.
   - Call `sync_pantry_inventory` with `action: "list"` and the active `householdId`.
   - When operating over MCP 2026-07-28, mirror the method, tool name, and household identifier in HTTP request headers (`Mcp-Method: tools/call`, `Mcp-Name: sync_pantry_inventory`, `Mcp-Param-HouseholdId: <householdId>`) to prevent `-32020 HeaderMismatch` errors.

2. **Normalize Units & Deduct In-Stock Quantities**
   - Pass aggregated recipe ingredients and pantry stock to `diff_pantry()` in `scripts/optimize_unit_price.py`.
   - The engine normalizes mass (kg, lb, oz, mg to base g), volume (l, cup, tbsp, tsp, fl oz to base ml), and discrete counts, applying cross-dimension culinary equivalents (1 bunch = 50g, 1 clove = 5g) when pantry and recipe dimensions differ.
   - Deduct consumed stock across multi-recipe plans so the household only purchases the net deficit.
   - Use token-safe Jaccard phrase matching (`tokenize_name`) rather than raw substring checks so modifier words or partial roots never trigger false collisions (for example, "egg" in "eggplant" or "nut" in "butternut").

---

### Stage 2: 4-Tier Unit-Price & Allergen Optimization

1. **Invoke `optimize_smart_cart` with SSE Streaming**
   Send a `POST /mcp` request with `Accept: application/json, text/event-stream` so the server streams real-time `notifications/progress` events to the Echo Show wire inspector and progress bar before returning the final JSON-RPC 2.0 result:

   ```json
   {
     "jsonrpc": "2.0",
     "id": "req-cart-01",
     "method": "tools/call",
     "params": {
       "name": "optimize_smart_cart",
       "arguments": {
         "householdId": "hh-ayush-01",
         "recipeIds": ["rec-palak-paneer-quinoa", "rec-spinach-yogurt-flatbread"],
         "budgetCapUsd": 25.0,
         "preferOrganic": true,
         "streamProgress": true
       }
     }
   }
   ```

2. **Enforce the 4-Tier Deterministic Resolution Order**
   Under the hood, `scripts/optimize_unit_price.py` resolves ingredient candidates in strict priority order:
   - **Tier 1 - Hard Safety Constraints (Big-9 Allergens & Medical):** Never permit an item whose `allergen_type` conflicts with active household allergies (Tree Nuts, Peanuts, Dairy, Eggs, Soy, Wheat/Gluten, Fish, Shellfish, Sesame). If the primary `substitute_candidate` also conflicts with a secondary allergy, recursively traverse `multi_constraint_fallback` (for example, pine nuts -> roasted pumpkin seeds -> hemp hearts).
   - **Tier 2 - Ethical & Cultural Diet Boundaries:** Enforce `dietary_Compatibility` (vegan, vegetarian, pescatarian, halal, kosher, jain, omnivore).
   - **Tier 3 - Expiring Pantry Substitute Rescue (≤48h):** If a safe substitute is already in `pantry_stock` and flagged `isExpiringUrgent: true` (or resolves an active allergen conflict), rescue the in-stock pantry item at $0.00 retail cost and record the full package price under `totalSavingsUsd`.
   - **Tier 4 - Two-Pass Unit-Price ($/g) & Budget Ceiling Optimization:**
     - *Pass 1 (Immediate Premium & Allergen Swaps):* Swap any allergen-conflicted item or high-unit-price garnish (`package_price_usd > $6.00`, such as Imported Pine Nuts at $0.099/g -> Roasted Pumpkin Seeds at $0.018/g, saving $6.31–$6.40).
     - *Pass 2 (Strict Budget-Cap Tightening):* If the Pass 1 cart subtotal still exceeds `budgetCapUsd`, sort remaining swappable items by largest dollar savings (`package_price_usd - sub.package_price_usd`) and apply deferred swaps (such as Pomegranate Arils $4.79 -> Organic Meyer Lemons $2.29, saving $2.50) until `totalCostUsd <= budgetCapUsd`.
   - All currency calculations use exact Decimal quantization (`ROUND_HALF_UP` to $0.01) to prevent floating-point drift.

3. **Offline Script Execution & Self-Diagnostic Verification**
   ```bash
   # Run built-in unit test suite (allergen swap, unit normalization, Pass 2 budget cap, collision guard)
   python3 scripts/optimize_unit_price.py --test

   # Run custom cart optimization from JSON payload or file with CLI overrides
   python3 scripts/optimize_unit_price.py \
     --input '{"needed_ingredients":[{"name":"Pine Nuts","requiredQuantity":50,"unit":"g"},{"name":"Pomegranate Arils","requiredQuantity":150,"unit":"g"}],"pantry_stock":[{"name":"Baby Spinach","quantity":0.5,"unit":"kg"}]}' \
     --budget 10.00 \
     --allergies "Tree Nuts"
   ```

---

### Stage 3: Mounting the Interactive Cart Carousel (MCP App)

1. **Attach the MCP App Resource**
   - Include `mcpAppResourceUri: "ui://hearth/cart-carousel"` in the tool response and read `ui://hearth/cart-carousel` via `resources/read` so the host mounts the interactive `@modelcontextprotocol/ext-apps` carousel on the Echo Show display.
   - The visual surface displays original vs. optimized totals, per-item savings badges, and 1-tap substitution toggles.

2. **Speak a Concise 2-Sentence Voice Prompt**
   - Keep spoken output to at most 2 sentences (under 35 words). Never read itemized SKU lists or unit-price math aloud over voice TTS.
   - *Recommended Voice Template:* "I've staged your smart cart with {item_count} missing items for ${totalCostUsd}, saving ${totalSavingsUsd} by swapping {original_item} for {replacement_item}. Review the cart on your screen and say 'Confirm checkout' when you're ready."

---

### Stage 4: Transactional Checkout Guardrails & Kitchen Timers

1. **Pre-Flight Safety Verification**
   Financial transactions on ambient voice devices require strict guardrails against background TV audio, children speaking, or hallucinated tool calls. Verify all four conditions before invoking `authorize_checkout`:
   - [x] **Explicit Confirmation Token:** `userConfirmationToken` must be present and start with `CONFIRMED` or equal `VERBAL_CONFIRM_YES` / `CONFIRM_TOUCH`, captured after the user has been informed of the final `totalCostUsd`.
   - [x] **Budget Ceiling Compliance:** Verify `totalCostUsd <= budgetCapUsd` (and `<= household.budgetRemainingUsd`). If `underBudget` is false, halt checkout and ask the user which item to remove.
   - [x] **Zero Active Allergen Conflicts:** Confirm every item in `cartItems` is cleared against the household's `allergies` list.
   - [x] **Header Mirroring Integrity:** Ensure `Mcp-Param-HouseholdId` matches `arguments.householdId`.

2. **Execute `authorize_checkout` & Post-Order Orchestration**
   ```json
   {
     "jsonrpc": "2.0",
     "id": "req-chk-02",
     "method": "tools/call",
     "params": {
       "name": "authorize_checkout",
       "arguments": {
         "householdId": "hh-ayush-01",
         "cartId": "cart-hearth-2026-99",
         "userConfirmationToken": "CONFIRMED_VOICE_YES"
       }
     }
   }
   ```

3. **Upon `CONFIRMED_AND_DISPATCHED`:**
   - Append the idempotent `orderId` (`AMZN-ECHO-XXXXXXXX`), `chargedUsd`, and `deliveryWindow` to order history in `hearth://household/memory`.
   - Call `stage_kitchen_timers` with `householdId` and `recipeId` to push synchronized multi-burner cooking timers to the Echo Show ambient display.
   - Announce the order confirmation ID, delivery window, and staged timers in ≤2 sentences.

---

## Gotchas & Protocol Error Recovery

| Failure Mode / Error Code | Root Cause | Deterministic Recovery Action |
| :--- | :--- | :--- |
| **`-32020 HeaderMismatch`** | `Mcp-Method`, `Mcp-Name`, or `Mcp-Param-HouseholdId` header diverges from JSON-RPC body under MCP 2026-07-28. | Re-serialize request ensuring exact byte parity between HTTP headers and JSON-RPC params. |
| **`-32602 Checkout Rejected`** | `authorize_checkout` called without a valid `userConfirmationToken` (`CONFIRMED*`). | Do not retry automatically. Prompt the user on voice/screen to explicitly confirm the exact dollar total first. |
| **`underBudget: false`** | Even after Pass 1 and Pass 2 substitutions, required items exceed `budgetCapUsd`. | Present lowest-cost cart on `ui://hearth/cart-carousel`, state exact overage, and ask whether to drop an item or raise cap. |
| **Cross-Dimension Pantry Mismatch** | Pantry stock is in mass (g/kg) while recipe requests counts (bunch/cloves). | Rely on `comparable_quantities()` in `scripts/optimize_unit_price.py` rather than raw subtraction so 0.5 kg spinach properly covers 200 g required. |
| **Substring Allergen False Positives** | Naive string matching flags "eggplant" for "Egg" allergy or "butternut squash" for "Tree Nuts". | Always route ingredient matching through `lookup_catalog_item()` and `tokenize_name()` to enforce token-boundary checks. |
