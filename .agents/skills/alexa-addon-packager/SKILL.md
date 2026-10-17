---
name: alexa-addon-packager
description: Introspects a live Streamable HTTP MCP server and scaffolds a compliant Alexa+ addon-package/addon.json manifest. Use when packaging, validating, or deploying an MCP server for Alexa+.
license: MIT
compatibility: Works with Alexa+ Streamable HTTP MCP servers (2025-11-25 & 2026-07-28), Amazon Bedrock AgentCore, and any Agent Skills runtime.
metadata:
  author: ayush-singh
  version: "1.0.0"
  track: alexa-plus
  mcp-transport: streamable-http
  allowed-tools: "tools/list resources/list"
---

# Alexa+ Add-on Packager Agent Skill

<!--
  Specification-Compliant Agent Skill (.agents/skills/ Open Standard).
  Solves Friction Entry 1: Automates offline packaging and schema validation
  for Alexa+ Streamable HTTP MCP add-on packages (addon.json).
  Kept strictly under 500 lines per the Agent Skills standard.
-->

## Purpose & Scope
The `alexa-addon-packager` skill solves the developer onboarding gap caused by Alexa's gated private-preview CLI tools. When an engineer or hackathon judge says "Package this MCP server for Alexa+" or clicks `[Export Alexa+ Add-on Package]` in the simulator inspector, this skill introspects the running `/mcp` endpoint, extracts all tools and resources, and generates a schema-compliant `addon-package/addon.json` package manifest ready for deployment.

---

## 3-Stage Introspection & Packaging Pipeline

```
┌────────────────────────────────────────────────────────┐
│ Stage 1: Protocol Discovery & Handshake                │
│ • POST /mcp initialize                                 │
│ • POST /mcp tools/list & resources/list                │
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────┴────────────────────────────┐
│ Stage 2: Schema Assembly & Python Scaffolding          │
│ • Execute scripts/scaffold_addon_manifest.py           │
│ • Validate output against references/alexa-addon-schema│
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────┴────────────────────────────┐
│ Stage 3: Package Emission & Verification               │
│ • Output addon-package/addon.json                      │
│ • Report discovered tool count & multimodal features   │
└────────────────────────────────────────────────────────┘
```

---

## Step-by-Step Execution Workflow

### Stage 1: Live Server Introspection
1. Send an `initialize` JSON-RPC request to the target server:
   ```json
   {
     "jsonrpc": "2.0",
     "id": 1,
     "method": "initialize",
     "params": {
       "protocolVersion": "2025-11-25",
       "clientInfo": { "name": "alexa-addon-packager", "version": "1.0.0" }
     }
   }
   ```
2. Retrieve the active tool list and resource list via `tools/list` and `resources/list`.

---

### Stage 2: Automated Scaffolding Script Execution
Execute the bundled Python script to compile the manifest:

```bash
# Introspect live server and output to addon-package/
python3 scripts/scaffold_addon_manifest.py --url http://localhost:3000/mcp

# Offline verification mode (uses bundled schema when server is offline)
python3 scripts/scaffold_addon_manifest.py --test
```

Under the hood, the script:
1. Ingests all tool names, descriptions, and input schemas.
2. Ingests stateful resources (`hearth://household/memory`) and MCP Apps (`ui://hearth/cart-carousel`).
3. Embeds RFC 9728 OAuth 2.1 PKCE discovery endpoints.
4. Generates Echo Show 21 display metadata and 3 starter voice phrases.

---

### Stage 3: Schema Validation Against `alexa-addon-schema.json`
Verify that the output manifest complies strictly with the schema:
- Schema reference: `references/alexa-addon-schema.json`
- Required keys validated:
  - [x] `schemaVersion`: `"1.0.0"`
  - [x] `addonId`: Valid alphanumeric slug (`"hearthsync-plus"`)
  - [x] `mcpServer`: Transport (`"streamable-http"`), URL, and protocol version
  - [x] `capabilities`: Verified tool and resource lists
  - [x] `displayMetadata`: Categories and Echo Show hardware targets
  - [x] `examplePhrases`: At least 3 natural voice prompts

---

## Output Artifact & Developer Hand-off
The generated manifest is saved directly to:
[`addon-package/addon.json`](file:///c:/Users/AYUSH/Documents/HearthSync+/addon-package/addon.json)

Judges or developers can copy this directory directly into their Alexa Developer Console or upload it to Amazon Bedrock AgentCore as a custom action group.
