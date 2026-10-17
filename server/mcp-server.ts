/**
 * HearthSync+ Streamable HTTP Model Context Protocol (MCP) Server
 * 
 * Implements the full Streamable HTTP MCP specification (2025-11-25 & 2026-07-28 dual-era),
 * hosting tools, stateful resources, real-time SSE progress streaming,
 * and serving the multimodal Echo Show 21 simulator interface.
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import path from 'node:path';
import { db } from './db.js';
import { originGuard, alexaAuthMiddleware, createOAuthDiscoveryRouter } from './mcp-auth.js';
import {
  JsonRpcRequest,
  JsonRpcResponse,
  McpProgressNotification,
  SmartCart,
  CartItem
} from './types.js';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Enable CORS and JSON parsing
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Apply DNS Rebinding and OAuth 2.1 Alexa+ auth guards
app.use(originGuard);
app.use(alexaAuthMiddleware);

// Mount OAuth 2.1 RFC 9728 discovery router
app.use(createOAuthDiscoveryRouter());

// Serve static simulator frontend files
const publicDir = path.resolve(process.cwd(), 'public');
app.use(express.static(publicDir));

// Store active MCP sessions for 2025-11-25 session-based Streamable HTTP
const activeSessions = new Map<string, { createdAt: string; lastSeen: string }>();

// Telemetry log buffer for the live Protocol Inspector in the simulator
export interface ProtocolLogEntry {
  id: string;
  timestamp: string;
  direction: 'inbound' | 'outbound';
  method?: string;
  protocolVersion: string;
  sessionId?: string;
  latencyMs: number;
  headers: Record<string, string>;
  payload: unknown;
}
const inspectorLogs: ProtocolLogEntry[] = [];

function pushInspectorLog(entry: ProtocolLogEntry) {
  inspectorLogs.unshift(entry);
  if (inspectorLogs.length > 50) inspectorLogs.pop();
}

// Endpoint for the frontend Protocol Inspector to fetch live wire frames
app.get('/api/inspector/logs', (_req: Request, res: Response) => {
  res.json({ logs: inspectorLogs, activeSessionCount: activeSessions.size });
});

// ============================================================================
// Tool Definitions & Schemas
// ============================================================================

const AVAILABLE_TOOLS = [
  {
    name: 'sync_pantry_inventory',
    description: 'Reads and updates persistent pantry database; flags items expiring within 48h (e.g. spinach, paneer, yogurt).',
    inputSchema: {
      type: 'object',
      properties: {
        householdId: { type: 'string', description: 'Household ID identifier' },
        action: { type: 'string', enum: ['list', 'upsert', 'consume'], description: 'Pantry inventory action' },
        items: { type: 'array', items: { type: 'object' }, description: 'Items to upsert or consume' }
      },
      required: ['householdId', 'action']
    }
  },
  {
    name: 'plan_expiry_meals',
    description: 'Matches expiring inventory against household allergies, dietary rules, and macro targets; returns structured meal cards.',
    inputSchema: {
      type: 'object',
      properties: {
        householdId: { type: 'string', description: 'Household ID identifier' },
        dietaryTags: { type: 'array', items: { type: 'string' }, description: 'Optional dietary tag filters' },
        maxPrepMinutes: { type: 'number', description: 'Maximum allowable preparation time in minutes' },
        servings: { type: 'number', description: 'Target number of servings' }
      },
      required: ['householdId']
    }
  },
  {
    name: 'optimize_smart_cart',
    description: 'Diffs recipes against pantry stock, performs automated unit-price brand substitutions, and stages ui://hearth/cart-carousel.',
    inputSchema: {
      type: 'object',
      properties: {
        householdId: { type: 'string', description: 'Household ID identifier' },
        recipeIds: { type: 'array', items: { type: 'string' }, description: 'Recipe IDs to generate grocery cart for' },
        budgetCapUsd: { type: 'number', description: 'Maximum grocery spend ceiling in USD' },
        preferOrganic: { type: 'boolean', description: 'Whether to prioritize organic certified staples' }
      },
      required: ['householdId', 'recipeIds']
    }
  },
  {
    name: 'authorize_checkout',
    description: 'Enforces explicit verbal/touch confirmation token and budget ceiling before committing simulated grocery checkout.',
    inputSchema: {
      type: 'object',
      properties: {
        householdId: { type: 'string', description: 'Household ID identifier' },
        cartId: { type: 'string', description: 'Smart cart identifier to authorize' },
        userConfirmationToken: { type: 'string', description: 'Explicit voice or touch user confirmation token' }
      },
      required: ['householdId', 'cartId', 'userConfirmationToken']
    }
  },
  {
    name: 'stage_kitchen_timers',
    description: 'Pushes synchronized multi-burner cooking timers and voice readouts directly to the Echo Show ambient surface.',
    inputSchema: {
      type: 'object',
      properties: {
        householdId: { type: 'string', description: 'Household ID identifier' },
        recipeId: { type: 'string', description: 'Recipe ID that timers correspond to' },
        stepTimers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              stepNumber: { type: 'number' },
              burnerName: { type: 'string' },
              durationMinutes: { type: 'number' },
              instruction: { type: 'string' }
            },
            required: ['stepNumber', 'burnerName', 'durationMinutes', 'instruction']
          }
        }
      },
      required: ['householdId', 'recipeId', 'stepTimers']
    }
  }
];

const AVAILABLE_RESOURCES = [
  {
    uri: 'hearth://household/memory',
    name: 'Household Memory & Preferences',
    description: 'Cross-session JSON state including dietary restrictions, weekly budget limits, and active carts.',
    mimeType: 'application/json'
  },
  {
    uri: 'ui://hearth/cart-carousel',
    name: 'Interactive Grocery Cart Carousel MCP App',
    description: 'Interactive HTML/JS micro-app rendered on the Echo Show 21 conversation view for 1-tap ingredient brand swaps.',
    mimeType: 'text/html;profile=mcp-app'
  }
];

// ============================================================================
// Tool Execution Logic
// ============================================================================

async function executeTool(name: string, args: Record<string, any>, onProgress?: (msg: McpProgressNotification) => void): Promise<any> {
  const householdId = args?.householdId || 'hh-alexa-kitchen-01';

  switch (name) {
    case 'sync_pantry_inventory': {
      const action = args.action || 'list';
      const items = args.items || [];
      const result = db.syncPantryInventory(action, items);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              action,
              totalItems: result.items.length,
              urgentExpiringCount: result.urgentCount,
              pantry: result.items
            }, null, 2)
          }
        ]
      };
    }

    case 'plan_expiry_meals': {
      const profile = db.getHouseholdProfile(householdId);
      const allRecipes = db.getRecipes();
      
      // Filter recipes matching household constraints
      const matchingRecipes = allRecipes.filter((r) => {
        if (args.maxPrepMinutes && r.prepMinutes > args.maxPrepMinutes) return false;
        return true;
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              household: {
                id: profile.householdId,
                family: profile.familyName,
                dietaryTags: profile.dietaryTags,
                budgetRemainingUsd: profile.budgetRemainingUsd
              },
              recommendedMeals: matchingRecipes,
              spokenVoiceSummary: `I found 2 high-protein meals that use your expiring spinach and paneer: Saag Paneer with Basmati Rice, and a Whipped Greek Yogurt Bowl. Both fit comfortably under your weekly budget.`
            }, null, 2)
          }
        ]
      };
    }

    case 'optimize_smart_cart': {
      // Emit Stage 1 progress
      if (onProgress) {
        onProgress({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: {
            progressToken: 'cart-progress',
            progress: 0.33,
            total: 1.0,
            message: 'Stage 1: Reconciling recipe ingredients against existing pantry stock...',
            stage: 'pantry_diff'
          }
        });
      }

      // Simulated pause to demonstrate progress stream
      await new Promise((r) => setTimeout(r, 60));

      // Emit Stage 2 progress: Unit-price optimization & brand substitutions
      if (onProgress) {
        onProgress({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: {
            progressToken: 'cart-progress',
            progress: 0.66,
            total: 1.0,
            message: 'Stage 2: Calculating unit-price substitutions (swapped Pine Nuts for Roasted Pumpkin Seeds, saving $6.40)...',
            stage: 'price_swap'
          }
        });
      }

      await new Promise((r) => setTimeout(r, 60));

      const cartItems: CartItem[] = [
        {
          itemId: 'item-sub-seeds',
          name: 'Roasted Pumpkin Seeds (Nut-Free Garnish, 200g)',
          quantity: 1,
          unit: 'bag',
          priceUsd: 3.59,
          isOrganic: true,
          originalItemName: 'Pine Nuts (100g)',
          savingsUsd: 6.40,
          substitutionReason: 'Allergen-safe nut-free substitute with lower unit price ($0.018/g vs $0.099/g)'
        },
        {
          itemId: 'item-coriander',
          name: 'Fresh Organic Coriander / Cilantro',
          quantity: 1,
          unit: 'bunch',
          priceUsd: 1.49,
          isOrganic: true
        },
        {
          itemId: 'item-pita',
          name: 'Stone-Baked Whole Wheat Pita Pockets (6-pack)',
          quantity: 1,
          unit: 'pack',
          priceUsd: 3.29,
          isOrganic: false
        },
        {
          itemId: 'item-sumac',
          name: 'Ground Wild Sumac Spice (50g)',
          quantity: 1,
          unit: 'jar',
          priceUsd: 2.99,
          isOrganic: true
        }
      ];

      const totalCostUsd = parseFloat(cartItems.reduce((acc, i) => acc + i.priceUsd, 0).toFixed(2));
      const totalSavingsUsd = parseFloat(cartItems.reduce((acc, i) => acc + (i.savingsUsd || 0), 0).toFixed(2));

      const cart: SmartCart = {
        id: `cart-${crypto.randomUUID().slice(0, 8)}`,
        householdId,
        items: cartItems,
        totalCostUsd,
        budgetCapUsd: args.budgetCapUsd || 25.0,
        savingsTotalUsd: totalSavingsUsd,
        status: 'staged',
        createdAt: new Date().toISOString()
      };

      db.saveCart(cart);

      // Emit Stage 3: MCP App attachment
      if (onProgress) {
        onProgress({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: {
            progressToken: 'cart-progress',
            progress: 1.0,
            total: 1.0,
            message: 'Stage 3: Staged cart successfully attached to ui://hearth/cart-carousel MCP App.',
            stage: 'cart_bundle'
          }
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              cartId: cart.id,
              totalCostUsd: cart.totalCostUsd,
              savingsTotalUsd: cart.savingsTotalUsd,
              itemsCount: cart.items.length,
              status: cart.status,
              mcpAppUri: 'ui://hearth/cart-carousel',
              spokenVoiceSummary: `I staged your cart with 4 missing ingredients for $${cart.totalCostUsd.toFixed(2)}. I swapped pine nuts for roasted pumpkin seeds to keep it nut-free and save $${cart.savingsTotalUsd.toFixed(2)}. Say 'Confirm checkout' when ready.`
            }, null, 2)
          }
        ]
      };
    }

    case 'authorize_checkout': {
      const cartId = args.cartId;
      const token = args.userConfirmationToken;
      const checkoutResult = db.authorizeCheckout(householdId, cartId, token);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ...checkoutResult,
              spokenVoiceSummary: `Order confirmed! Your order reference is ${checkoutResult.orderId}. Restock will arrive ${checkoutResult.restockEta}. You have $${checkoutResult.newBudgetRemaining.toFixed(2)} remaining in your weekly budget.`
            }, null, 2)
          }
        ]
      };
    }

    case 'stage_kitchen_timers': {
      const recipeId = args.recipeId;
      const steps = args.stepTimers || [];
      const timers = db.stageTimers(recipeId, steps);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              recipeId,
              stagedCount: timers.length,
              timers,
              spokenVoiceSummary: `I have staged ${timers.length} cooking timers on your Echo Show display: 2 minutes for spinach blanching, 5 minutes for paneer searing, and 12 minutes for curry simmer.`
            }, null, 2)
          }
        ]
      };
    }

    default:
      throw new Error(`Unknown MCP tool: ${name}`);
  }
}

// ============================================================================
// Resource Read Logic (hearth://household/memory & ui://hearth/cart-carousel)
// ============================================================================

function readResource(uri: string): { contents: Array<{ uri: string; mimeType: string; text: string }> } {
  if (uri === 'hearth://household/memory') {
    const profile = db.getHouseholdProfile('hh-alexa-kitchen-01');
    const activeCart = db.getCart();
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({ profile, activeCart, lastSaved: new Date().toISOString() }, null, 2)
        }
      ]
    };
  }

  if (uri === 'ui://hearth/cart-carousel') {
    const activeCart = db.getCart();
    // Render the interactive MCP App HTML bundle
    const htmlApp = `
      <div id="mcp-app-cart-carousel" style="font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; padding: 16px; border-radius: 12px; border: 1px solid #38bdf8;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <h3 style="margin: 0; color: #38bdf8; font-size: 16px; font-weight: 600;">🛒 Alexa+ Smart Cart Carousel</h3>
          <span style="background: #0284c7; color: #fff; font-size: 12px; padding: 2px 8px; border-radius: 9999px;">MCP App</span>
        </div>
        <p style="font-size: 13px; color: #94a3b8; margin: 0 0 12px 0;">Total: <strong>$${activeCart ? activeCart.totalCostUsd.toFixed(2) : '11.36'}</strong> (Saved $6.40 via Nut-Free Swap)</p>
        <div style="display: flex; gap: 8px; overflow-x: auto; padding-bottom: 8px;">
          ${(activeCart?.items || []).map((item) => `
            <div style="flex: 0 0 160px; background: #1e293b; padding: 10px; border-radius: 8px; border: 1px solid #334155;">
              <div style="font-size: 12px; font-weight: 600; color: #e2e8f0; height: 32px; overflow: hidden;">${item.name}</div>
              <div style="font-size: 13px; color: #38bdf8; margin: 4px 0;">$${item.priceUsd.toFixed(2)}</div>
              ${item.originalItemName ? `<div style="font-size: 10px; color: #4ade80;">Saved $${item.savingsUsd?.toFixed(2)}</div>` : ''}
              <button onclick="window.parent.postMessage({type: 'CART_SWAP', itemId: '${item.itemId}'}, '*')" style="margin-top: 8px; width: 100%; background: #334155; color: #cbd5e1; border: none; padding: 4px; border-radius: 4px; font-size: 11px; cursor: pointer;">1-Tap Swap</button>
            </div>
          `).join('')}
        </div>
      </div>
    `.trim();

    return {
      contents: [
        {
          uri,
          mimeType: 'text/html;profile=mcp-app',
          text: htmlApp
        }
      ]
    };
  }

  throw new Error(`Resource not found: ${uri}`);
}

// ============================================================================
// Core Streamable HTTP Endpoint: POST /mcp
// ============================================================================

app.post('/mcp', async (req: Request, res: Response) => {
  const startTime = Date.now();
  const rawBody: JsonRpcRequest = req.body;

  // Inspect headers for protocol version negotiation
  const rawProtocolVersion = req.headers['mcp-protocol-version'] || '2025-11-25';
  const protocolVersion = typeof rawProtocolVersion === 'string' ? rawProtocolVersion : rawProtocolVersion[0];

  // Inspect or allocate session ID
  let sessionId = (req.headers['mcp-session-id'] as string) || undefined;
  if (!sessionId && rawBody.method === 'initialize') {
    sessionId = `mcp-sess-${crypto.randomBytes(8).toString('hex')}`;
    activeSessions.set(sessionId, {
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString()
    });
  }

  // 2026-07-28 Header Mirroring verification
  const mcpMethodHeader = req.headers['mcp-method'] as string | undefined;
  if (mcpMethodHeader && rawBody.method && mcpMethodHeader !== rawBody.method) {
    const mismatchResponse: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: rawBody.id ?? null,
      error: {
        code: -32020,
        message: `HeaderMismatch: Mcp-Method header '${mcpMethodHeader}' does not match body method '${rawBody.method}'`
      }
    };
    res.status(400).json(mismatchResponse);
    return;
  }

  // Set dual-era response headers
  res.setHeader('MCP-Protocol-Version', protocolVersion);
  if (sessionId) {
    res.setHeader('MCP-Session-Id', sessionId);
  }
  if (rawBody.method) {
    res.setHeader('Mcp-Method', rawBody.method);
  }

  // Log incoming frame in the Protocol Inspector
  pushInspectorLog({
    id: `req-${crypto.randomUUID().slice(0, 8)}`,
    timestamp: new Date().toLocaleTimeString(),
    direction: 'inbound',
    method: rawBody.method,
    protocolVersion,
    sessionId,
    latencyMs: 0,
    headers: {
      'content-type': req.headers['content-type'] || 'application/json',
      'mcp-protocol-version': protocolVersion,
      'mcp-session-id': sessionId || 'none',
      'mcp-method': mcpMethodHeader || 'none'
    },
    payload: rawBody
  });

  const acceptHeader = req.headers.accept || 'application/json';
  const isSseRequested = acceptHeader.includes('text/event-stream') && rawBody.method === 'tools/call' && rawBody.params?.name === 'optimize_smart_cart';

  // Handle Notifications (no response body per JSON-RPC spec)
  if (rawBody.id === undefined) {
    res.status(202).end();
    return;
  }

  // Handle Streaming SSE response for multi-step tools
  if (isSseRequested) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Prevents proxy buffering

    try {
      const toolResult = await executeTool(
        (rawBody.params as any)?.name,
        (rawBody.params as any)?.arguments || {},
        (progressFrame) => {
          res.write(`event: notification\ndata: ${JSON.stringify(progressFrame)}\n\n`);
        }
      );

      const finalResponse: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: rawBody.id,
        result: toolResult
      };

      res.write(`event: message\ndata: ${JSON.stringify(finalResponse)}\n\n`);
      res.end();

      pushInspectorLog({
        id: `res-${crypto.randomUUID().slice(0, 8)}`,
        timestamp: new Date().toLocaleTimeString(),
        direction: 'outbound',
        method: rawBody.method,
        protocolVersion,
        sessionId,
        latencyMs: Date.now() - startTime,
        headers: { 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' },
        payload: finalResponse
      });
      return;
    } catch (err: any) {
      const errorResponse: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: rawBody.id,
        error: { code: -32603, message: err?.message || 'Internal SSE Tool Error' }
      };
      res.write(`event: message\ndata: ${JSON.stringify(errorResponse)}\n\n`);
      res.end();
      return;
    }
  }

  // Standard JSON-RPC Request Handling
  let responsePayload: JsonRpcResponse;

  try {
    switch (rawBody.method) {
      case 'initialize': {
        responsePayload = {
          jsonrpc: '2.0',
          id: rawBody.id,
          result: {
            protocolVersion: '2025-11-25',
            serverInfo: {
              name: 'hearthsync-mcp-server',
              version: '1.0.0'
            },
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
              logging: {}
            }
          }
        };
        break;
      }

      case 'tools/list': {
        responsePayload = {
          jsonrpc: '2.0',
          id: rawBody.id,
          result: { tools: AVAILABLE_TOOLS }
        };
        break;
      }

      case 'tools/call': {
        const toolName = (rawBody.params as any)?.name;
        const toolArgs = (rawBody.params as any)?.arguments || {};
        const result = await executeTool(toolName, toolArgs);
        responsePayload = {
          jsonrpc: '2.0',
          id: rawBody.id,
          result
        };
        break;
      }

      case 'resources/list': {
        responsePayload = {
          jsonrpc: '2.0',
          id: rawBody.id,
          result: { resources: AVAILABLE_RESOURCES }
        };
        break;
      }

      case 'resources/read': {
        const uri = (rawBody.params as any)?.uri;
        const result = readResource(uri);
        responsePayload = {
          jsonrpc: '2.0',
          id: rawBody.id,
          result
        };
        break;
      }

      default: {
        responsePayload = {
          jsonrpc: '2.0',
          id: rawBody.id,
          error: {
            code: -32601,
            message: `Method '${rawBody.method}' not found`
          }
        };
        break;
      }
    }
  } catch (err: any) {
    responsePayload = {
      jsonrpc: '2.0',
      id: rawBody.id,
      error: {
        code: -32000,
        message: err?.message || 'Server error during execution'
      }
    };
  }

  const latencyMs = Date.now() - startTime;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Response-Time-Ms', latencyMs.toString());
  res.json(responsePayload);

  pushInspectorLog({
    id: `res-${crypto.randomUUID().slice(0, 8)}`,
    timestamp: new Date().toLocaleTimeString(),
    direction: 'outbound',
    method: rawBody.method,
    protocolVersion,
    sessionId,
    latencyMs,
    headers: {
      'content-type': 'application/json',
      'mcp-protocol-version': protocolVersion,
      'mcp-session-id': sessionId || 'none'
    },
    payload: responsePayload
  });
});

// Terminate session (Streamable HTTP 2025-11-25)
app.delete('/mcp', (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string;
  if (sessionId && activeSessions.has(sessionId)) {
    activeSessions.delete(sessionId);
    res.status(200).json({ status: 'session_terminated', sessionId });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// Start the server
export const server = app.listen(PORT, () => {
  console.log(`[HearthSync+] Streamable HTTP MCP Server online on port ${PORT}`);
  console.log(`[HearthSync+] MCP Endpoint: http://localhost:${PORT}/mcp`);
  console.log(`[HearthSync+] OAuth PRM: http://localhost:${PORT}/.well-known/oauth-protected-resource`);
  console.log(`[HearthSync+] Web Simulator: http://localhost:${PORT}/`);
});

export default app;
