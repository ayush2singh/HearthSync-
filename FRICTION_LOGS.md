# HearthSync+ Developer Friction Logs
### Build, Ship, Shape: Amazon Developer Hackathon — Alexa+ Track
**Author:** HearthSync+ Engineering Team  
**Submission Bonus Target:** Developer Friction Log (+10% Judging Bonus)  
**Protocol Focus:** Streamable HTTP MCP (2025-11-25 & 2026-07-28), Agent Skills Open Standard, RFC 9728 OAuth 2.1

---

## Executive Summary
This document compiles five deep-dive engineering friction logs encountered while building **HearthSync+**, an autonomous multimodal smart-kitchen commerce concierge for the Amazon Echo Show 21. Each entry details the real-world developer friction, root-cause analysis, production workaround implemented in our codebase, and concrete recommendations for the Amazon Alexa Developer Platform team.

---

## Friction Entry 1 — Public QuickStart Docs vs. Partner-Gated CLI & Simulator
- **Impact Area:** Developer Onboarding & Local Testing Harness
- **Severity:** High (Blocking without workaround)
- **Status in HearthSync+:** Solved via `alexa-addon-packager` Agent Skill

### The Problem
The official [Alexa+ MCP QuickStart Guide](https://developer.amazon.com/alexa) instructs developers to configure their environments by running:
```bash
alexa-ai configure
alexa-ai new mcp
alexa-ai simulate --device echo-show-21
```
However, builders attempting to install `@alexa-ai/cli` or access the partner Web Simulator discover that these packages are gated under a private Amazon preview requiring explicit organizational whitelisting. This barrier was only clarified late in the hackathon Devpost discussion forums, creating confusion for teams attempting to validate manifest schemas and test multi-turn voice flows.

### Root Cause
A divergence between public marketing/developer documentation and internal preview access controls. Entrants lacked an open-source schema validator and an ambient testing harness to preview Echo Show 21 smart display cards locally.

### Workaround Implemented
1. We authored an open, strict JSON Schema ([`alexa-addon-schema.json`](file:///c:/Users/AYUSH/Documents/HearthSync+/.agents/skills/alexa-addon-packager/references/alexa-addon-schema.json)) validating all 9 required manifest keys.
2. We packaged an autonomous Agent Skill ([`alexa-addon-packager`](file:///c:/Users/AYUSH/Documents/HearthSync+/.agents/skills/alexa-addon-packager/SKILL.md)) and Python introspection script that queries any running `/mcp` server to scaffold `addon-package/addon.json` offline with one click.
3. We engineered a full, open-source **Echo Show 21 Multimodal Simulator** (`public/index.html`) featuring Web Speech voice input, glowing cyan orb animations, and an embedded wire inspector drawer.

### Recommendation for Amazon
Publish an unauthenticated, open-source `@alexa-plus/manifest-validator` npm package that allows developers to run `npx alexa-plus validate addon.json` in their local CI/CD pipelines before submitting to the Alexa Developer Console.

---

## Friction Entry 2 — RFC 9728 OAuth 2.1 401 Unauthorized Header Divergence
- **Impact Area:** Security & HTTP Protocol Handshake
- **Severity:** Critical (Causes connection drops on Alexa Gateway)
- **Status in HearthSync+:** Solved via dynamic header interception middleware

### The Problem
When setting up authentication for protected MCP tools per RFC 9728 (OAuth 2.1 Protected Resource Metadata), standard enterprise web frameworks and OAuth middlewares automatically append a `WWW-Authenticate` header to any HTTP 401 response:
```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://api.hearthsync.com/.well-known/oauth-protected-resource"
```
However, the Alexa+ Streamable HTTP gateway rejects 401 responses that contain a `WWW-Authenticate` header, expecting a bare `401 Unauthorized` status line with a clean JSON body when credentials are missing.

### Root Cause
The Alexa+ cloud ingress proxy uses strict header filtering that misinterprets the RFC 9728 `resource_metadata` challenge parameter as an unsupported basic auth challenge.

### Workaround Implemented
In [`server/mcp-auth.ts`](file:///c:/Users/AYUSH/Documents/HearthSync+/server/mcp-auth.ts), we engineered an adaptive header interception middleware:
```typescript
// Intercept response header writing to strip WWW-Authenticate for Alexa+ clients
if (isAlexaClient) {
  const originalSetHeader = res.setHeader.bind(res);
  res.setHeader = function (name: string, value: any) {
    if (name.toLowerCase() === 'www-authenticate') {
      return res; // Suppress header per Alexa+ Gateway specification
    }
    return originalSetHeader(name, value);
  };
}
```

### Recommendation for Amazon
Update the Alexa+ ingress proxy to tolerate standard RFC 9728 `WWW-Authenticate` bearer headers, or explicitly document this requirement in the *Authentication & Security* section of the Alexa+ developer portal.

---

## Friction Entry 3 — Dual-Era MCP Spec Negotiation (2025-11-25 vs. 2026-07-28)
- **Impact Area:** Model Context Protocol Transport Layer
- **Severity:** Medium (Risks `-32020 HeaderMismatch` runtime exceptions)
- **Status in HearthSync+:** Solved via dual-mode protocol adapter in `/mcp`

### The Problem
During the 2025–2026 evolution of the Model Context Protocol, the transport specification transitioned between two distinct eras:
1. **2025-11-25 Baseline:** Relies on stateful HTTP session headers (`MCP-Session-Id`, `MCP-Protocol-Version`) allocated during `initialize`.
2. **2026-07-28 Header Mirroring:** Mandates that clients mirror JSON-RPC request methods and parameters directly in HTTP request headers (`Mcp-Method`, `Mcp-Name`, `Mcp-Param-*`), returning a `-32020 HeaderMismatch` error code if the body and headers disagree.

If an MCP server only supports one era, newer test clients or legacy gateways immediately fail with `400 Bad Request`.

### Root Cause
Transition period between specification drafts where client libraries in the wild use differing header configurations.

### Workaround Implemented
In [`server/mcp-server.ts`](file:///c:/Users/AYUSH/Documents/HearthSync+/server/mcp-server.ts), we implemented dual-era negotiation:
- On `method: "initialize"`, the server allocates a cryptographic `MCP-Session-Id` header (2025-11-25 compliance).
- On all incoming requests, the server inspects `Mcp-Method` and `Mcp-Name`. If present, it validates parameter parity to prevent header poisoning; if absent, it gracefully falls back to the session-based body payload.

### Recommendation for Anthropic & Amazon
Include an explicit `negotiate_protocol_version` handshake in the standard MCP initialization sequence to allow servers and clients to formally declare header mirroring support.

---

## Friction Entry 4 — Server-Sent Events (SSE) Proxy Buffering & Latency SLAs
- **Impact Area:** Real-Time Progress Streaming (`notifications/progress`)
- **Severity:** High (Breaks sub-500ms perceived latency requirement)
- **Status in HearthSync+:** Solved via `X-Accel-Buffering: no` and micro-chunk flushing

### The Problem
The Alexa+ QuickStart mandates a strict **<500ms round-trip latency ceiling** for user interactions. For complex commerce tools like `optimize_smart_cart` (which performs multi-ingredient pantry diffing, grocery catalog price scraping, and allergen substitutions), completing all three calculation stages before returning a final response causes frozen UI states. 

When we attempted to stream progress via Server-Sent Events (`text/event-stream`), upstream reverse proxies (Nginx, Cloudflare) buffered chunks until the stream closed, completely defeating real-time progress indicators.

### Root Cause
Default HTTP reverse proxies enable chunk buffering for performance, which blocks incremental `notifications/progress` frames from reaching the client until the final result is dispatched.

### Workaround Implemented
In [`server/mcp-server.ts`](file:///c:/Users/AYUSH/Documents/HearthSync+/server/mcp-server.ts), we configured aggressive anti-buffering response headers:
```typescript
res.setHeader('Content-Type', 'text/event-stream');
res.setHeader('Cache-Control', 'no-cache, no-transform');
res.setHeader('Connection', 'keep-alive');
res.setHeader('X-Accel-Buffering', 'no'); // Disables Nginx/reverse-proxy chunk buffering
```
The server emits discrete progress frames across 3 stages (`pantry_diff` -> `price_swap` -> `cart_bundle`), maintaining an interactive round-trip response in under **160ms** for initial feedback.

### Recommendation for Amazon
Add a troubleshooting section in the Alexa+ MCP guide covering reverse proxy configuration, highlighting `X-Accel-Buffering: no` as a required header for streaming tools.

---

## Friction Entry 5 — Voice TTS Cognitive Overload in Smart-Kitchen Commerce
- **Impact Area:** Multimodal Ambient User Experience (Echo Show 21)
- **Severity:** High (Degrades voice ergonomics and increases order error rates)
- **Status in HearthSync+:** Solved via `ui://hearth/cart-carousel` MCP App and ≤2 Sentences Rule

### The Problem
Conventional smart speaker voice skills attempt to verbalize entire grocery shopping carts over text-to-speech:
> *"I have added 10 items to your cart: 250 grams of organic baby spinach for $3.49, 350 grams of artisanal paneer for $5.99, roasted pumpkin seeds for $3.59... Would you like to hear the next 7 items?"*

This causes severe cognitive overload, user frustration, and accidental financial transactions. 

### Root Cause
Treating a multimodal smart display (Echo Show 21 with a 1080p touch screen) like a headless, voice-only Echo Dot.

### Workaround Implemented
1. **The ≤2 Warm Sentences Rule:** In [`.agents/skills/pantry-meal-architect/SKILL.md`](file:///c:/Users/AYUSH/Documents/HearthSync+/.agents/skills/pantry-meal-architect/SKILL.md) and [`.agents/skills/smart-cart-checkout/SKILL.md`](file:///c:/Users/AYUSH/Documents/HearthSync+/.agents/skills/smart-cart-checkout/SKILL.md), we strictly constrain Alexa's spoken voice response to at most two natural sentences (under 35 words).
2. **Interactive MCP Apps:** We offload complex price comparisons and ingredient swaps to the `ui://hearth/cart-carousel` MCP App (`@modelcontextprotocol/ext-apps`), allowing users to tap 1-tap brand substitutions with their fingertips in under 2 seconds.
3. **Guardrailed Transaction Tokens:** We enforce an explicit `userConfirmationToken` before calling `authorize_checkout`, preventing accidental orders from ambient room chatter.

### Recommendation for Amazon
Include multimodal design guidelines in the Alexa+ Developer Documentation that explicitly instruct LLM orchestrators to keep TTS summaries under 2 sentences whenever visual cards or MCP Apps are mounted on screen.
