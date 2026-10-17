/**
 * HearthSync+ Core Type Definitions
 * 
 * Defines data models for household memory, smart pantry inventory,
 * recipe planning, cart optimization, kitchen timers, and MCP JSON-RPC protocol frames.
 */

// ============================================================================
// 1. Household & Persistent Memory Models
// ============================================================================

/** Macro targets to support nutritional meal planning */
export interface MacroTargets {
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  calories: number;
}

/** Household profile stored across sessions in hearth://household/memory */
export interface HouseholdProfile {
  householdId: string;
  familyName: string;
  dietaryTags: string[]; // e.g. ["vegetarian", "nut-free", "high-protein"]
  allergies: string[];
  weeklyBudgetUsd: number;
  budgetRemainingUsd: number;
  macroTargets: MacroTargets;
  activeCartId?: string;
  lastActiveSession: string;
}

// ============================================================================
// 2. Pantry Inventory Models
// ============================================================================

export type PantryCategory = 'produce' | 'dairy' | 'protein' | 'pantry' | 'spices';

/** Individual item currently tracked in the kitchen pantry */
export interface PantryItem {
  id: string;
  name: string;
  category: PantryCategory;
  quantity: number;
  unit: string; // e.g. "g", "bunch", "carton", "oz"
  expiryDate: string; // ISO 8601 string (e.g. "2026-10-18")
  daysUntilExpiry: number;
  isExpiringUrgent: boolean; // true if expiring within 48 hours
  estimatedCostUsd: number;
}

// ============================================================================
// 3. Recipe & Meal Planning Models
// ============================================================================

export interface RecipeIngredient {
  name: string;
  requiredQuantity: number;
  unit: string;
  inPantry: boolean;
  pantryItemId?: string;
}

export interface CookingTimerStep {
  stepNumber: number;
  burnerName: string; // e.g. "Front Left Burner", "Oven"
  durationMinutes: number;
  instruction: string;
}

/** Multimodal recipe card rendered on the Echo Show 21 smart display */
export interface RecipeMealCard {
  id: string;
  title: string;
  description: string;
  servings: number;
  prepMinutes: number;
  cookMinutes: number;
  ingredients: RecipeIngredient[];
  nutritionPerServing: {
    proteinGrams: number;
    calories: number;
    carbsGrams: number;
    fatGrams: number;
  };
  estimatedCostPerServingUsd: number;
  usesExpiringItems: string[];
  instructions: string[];
  timers: CookingTimerStep[];
}

// ============================================================================
// 4. Smart Cart & Commerce Checkout Models
// ============================================================================

export interface CartItem {
  itemId: string;
  name: string;
  quantity: number;
  unit: string;
  priceUsd: number;
  isOrganic: boolean;
  originalItemName?: string; // Set when substituted for unit-price savings
  savingsUsd?: number;
  substitutionReason?: string;
}

export interface SmartCart {
  id: string;
  householdId: string;
  items: CartItem[];
  totalCostUsd: number;
  budgetCapUsd: number;
  savingsTotalUsd: number;
  status: 'draft' | 'staged' | 'authorized' | 'completed';
  userConfirmationToken?: string;
  createdAt: string;
}

// ============================================================================
// 5. Kitchen Timers (Echo Show Ambient Surface)
// ============================================================================

export interface ActiveKitchenTimer {
  timerId: string;
  recipeId: string;
  burnerName: string;
  label: string;
  durationSeconds: number;
  remainingSeconds: number;
  status: 'running' | 'paused' | 'completed';
}

// ============================================================================
// 6. Model Context Protocol (MCP) Streamable HTTP & JSON-RPC Frames
// ============================================================================

/** Supported protocol versions across the 2025-11-25 and 2026-07-28 specifications */
export type McpProtocolVersion = '2025-11-25' | '2026-07-28';

/** Standard JSON-RPC 2.0 Request Frame */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

/** Standard JSON-RPC 2.0 Response Frame */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** SSE Progress Notification Frame emitted during streaming cart diffs */
export interface McpProgressNotification {
  jsonrpc: '2.0';
  method: 'notifications/progress';
  params: {
    progressToken: string | number;
    progress: number; // 0.0 to 1.0
    total: number;
    message: string;
    stage: 'pantry_diff' | 'price_swap' | 'cart_bundle';
  };
}

/** MCP App Embedded UI metadata for interactive widgets */
export interface McpAppResource {
  uri: string; // e.g. "ui://hearth/cart-carousel"
  mimeType: 'text/html;profile=mcp-app';
  name: string;
  description: string;
}
