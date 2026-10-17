# HearthSync+ Architecture & Implementation Roadmap Audit

<!--
  This roadmap acts as the single source of truth for the HearthSync+ project.
  It audits the 17 sequential milestones required to build an autonomous,
  multimodal smart-kitchen concierge for the Build, Ship, Shape: Amazon Developer Hackathon.
  Each milestone is strictly mapped to one file in bottom-up dependency order.
-->

## Executive Overview
HearthSync+ is an ambient, multimodal household and kitchen commerce orchestrator built for smart displays like the Amazon Echo Show 21. It combines:
1. **Streamable HTTP Model Context Protocol (MCP) Server**: Full dual-era compatibility (2025-11-25 sessions & 2026-07-28 header mirroring), RFC 9728 OAuth 2.1 PKCE discovery, and Server-Sent Events (SSE) progress streaming.
2. **Modular Agent Skills**: Built to the open `SKILL.md` specification (`pantry-meal-architect`, `smart-cart-checkout`, and `alexa-addon-packager`).
3. **Echo Show 21 Multimodal Simulator**: An ambient smart display client featuring Web Speech voice I/O, touch recipe cards, interactive MCP Apps (`ui://hearth/cart-carousel`), and a live JSON-RPC/SSE wire protocol inspector.
4. **Developer Friction Logs**: Documenting real-world protocol nuances and developer experience gaps for the hackathon +10% bonus.

---

## Dependency & Architectural Audit

```
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 5: Bonus Documentation (FRICTION_LOGS.md)                        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────┴────────────────────────────────────┐
│ Phase 4: Echo Show 21 Simulator (index.html → styles.css → app.js)     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ consumes /mcp & skills
┌───────────────────────────────────┴────────────────────────────────────┐
│ Phase 3: Agent Skills Open Standard (.agents/skills/*)                 │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ coordinates with
┌───────────────────────────────────┴────────────────────────────────────┐
│ Phase 2: Core Server & Database (types.ts → db.ts → auth.ts → server.ts)│
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ built upon
┌───────────────────────────────────┴────────────────────────────────────┐
│ Phase 1: Environment & Config (package.json → tsconfig.json)           │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 17-Step Milestone Audit Matrix

| Step | Target File | Phase | Primary Purpose | Dependencies (Created Prior) |
| :--- | :--- | :--- | :--- | :--- |
| **01** | `package.json` | 1: Config | Project manifest, dependencies (`@modelcontextprotocol/sdk`, Express, better-sqlite3), and execution scripts. | None |
| **02** | `tsconfig.json` | 1: Config | TypeScript compiler configuration (ES2022, NodeNext resolution, strict mode). | `package.json` |
| **03** | `server/types.ts` | 2: Models | Protocol models, pantry inventory types, recipe structures, and JSON-RPC message contracts. | None |
| **04** | `server/db.ts` | 2: Data | Persistent storage engine for pantry items, household memory, dietary tags, and shopping history. | `server/types.ts` |
| **05** | `server/mcp-auth.ts` | 2: Auth | RFC 9728 discovery endpoints (`/.well-known/oauth-protected-resource`) and Alexa+ 401 header compliance. | `server/types.ts` |
| **06** | `server/mcp-server.ts` | 2: Server | Streamable HTTP MCP server hosting tools (`sync_pantry`, `plan_meals`, `optimize_cart`, `checkout`), resources, and SSE. | `server/types.ts`, `server/db.ts`, `server/mcp-auth.ts` |
| **07** | `.agents/skills/pantry-meal-architect/references/macro-substitution-matrix.md` | 3: Skills | Lookup table providing allergen-safe, high-protein ingredient swaps. | None |
| **08** | `.agents/skills/pantry-meal-architect/SKILL.md` | 3: Skills | Skill definition orchestrating zero-waste meal generation from expiring ingredients. | Step 07 reference |
| **09** | `.agents/skills/smart-cart-checkout/scripts/optimize_unit_price.py` | 3: Skills | Deterministic cart diffing and price comparison script. | None |
| **10** | `.agents/skills/smart-cart-checkout/SKILL.md` | 3: Skills | Skill definition managing cart diffing, budget ceilings, and checkout confirmation. | Step 09 script |
| **11** | `.agents/skills/alexa-addon-packager/references/alexa-addon-schema.json` | 3: Skills | JSON schema validating Alexa+ Add-on package manifests. | None |
| **12** | `.agents/skills/alexa-addon-packager/scripts/scaffold_addon_manifest.py` | 3: Skills | Python script introspecting the `/mcp` server to scaffold `addon.json`. | Step 11 schema |
| **13** | `.agents/skills/alexa-addon-packager/SKILL.md` | 3: Skills | Skill definition for one-click Alexa+ Add-on packaging. | Step 11 schema, Step 12 script |
| **14** | `public/index.html` | 4: Frontend | DOM skeleton for Echo Show 21 ambient UI and the live Wire Protocol Inspector. | None |
| **15** | `public/styles.css` | 4: Frontend | Visual styling, responsive grid, Alexa cyan voice orb animation, and dark mode theme. | `public/index.html` |
| **16** | `public/app.js` | 4: Frontend | Web Speech voice integration, live MCP HTTP client, MCP App rendering, and inspector telemetry. | `public/index.html`, `public/styles.css` |
| **17** | `FRICTION_LOGS.md` | 5: Bonus | 5 documented developer friction logs with root-cause analysis and workarounds for judges. | All prior steps |

---

## Strict Rule Adherence Check
- **No Phantom Imports**: Every file only depends on files created in earlier steps.
- **Single File Lock**: Each response creates or edits strictly one file.
- **Pedagogical Progression**: Every step includes plain-English purpose, inline-commented code, key concepts, and an interactive verification check.
