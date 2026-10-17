/**
 * HearthSync+ Persistent Kitchen State & Memory Database Layer
 * 
 * Manages persistent state for household profiles, expiring pantry inventory,
 * recipe catalogs, active smart grocery carts, and multi-burner kitchen timers.
 * Uses atomic disk-backed JSON persistence to ensure zero-loss cross-session memory.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  HouseholdProfile,
  PantryItem,
  RecipeMealCard,
  SmartCart,
  ActiveKitchenTimer,
  CookingTimerStep
} from './types.js';

interface DatabaseSchema {
  household: HouseholdProfile;
  pantry: PantryItem[];
  carts: Record<string, SmartCart>;
  timers: ActiveKitchenTimer[];
}

// File path for atomic state persistence
const DB_FILE_PATH = path.resolve(process.cwd(), 'hearthsync-state.json');

/**
 * Default initial seed data matching the Alexa+ Hackathon PRD specifications:
 * - 3 Expiring items: Baby Spinach (24h), Fresh Paneer (36h), Greek Yogurt (48h)
 * - Household profile: Vegetarian, Nut-Free, $65/week budget cap
 */
function createDefaultSeed(): DatabaseSchema {
  const now = new Date();
  
  const addHours = (hours: number): string => {
    return new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString().split('T')[0];
  };

  return {
    household: {
      householdId: 'hh-alexa-kitchen-01',
      familyName: 'Miller Family',
      dietaryTags: ['Vegetarian', 'Nut-Free', 'High-Protein'],
      allergies: ['Peanuts', 'Tree Nuts'],
      weeklyBudgetUsd: 65.0,
      budgetRemainingUsd: 48.5,
      macroTargets: {
        proteinGrams: 95,
        carbsGrams: 140,
        fatGrams: 40,
        calories: 1850
      },
      lastActiveSession: now.toISOString()
    },
    pantry: [
      {
        id: 'item-spinach',
        name: 'Organic Baby Spinach',
        category: 'produce',
        quantity: 250,
        unit: 'g',
        expiryDate: addHours(24),
        daysUntilExpiry: 1,
        isExpiringUrgent: true,
        estimatedCostUsd: 3.49
      },
      {
        id: 'item-paneer',
        name: 'Fresh Artisanal Paneer',
        category: 'dairy',
        quantity: 350,
        unit: 'g',
        expiryDate: addHours(36),
        daysUntilExpiry: 1,
        isExpiringUrgent: true,
        estimatedCostUsd: 5.99
      },
      {
        id: 'item-yogurt',
        name: 'Plain Whole Milk Greek Yogurt',
        category: 'dairy',
        quantity: 450,
        unit: 'g',
        expiryDate: addHours(48),
        daysUntilExpiry: 2,
        isExpiringUrgent: true,
        estimatedCostUsd: 4.29
      },
      {
        id: 'item-rice',
        name: 'Aged Basmati Rice',
        category: 'pantry',
        quantity: 1000,
        unit: 'g',
        expiryDate: addHours(24 * 180),
        daysUntilExpiry: 180,
        isExpiringUrgent: false,
        estimatedCostUsd: 6.5
      },
      {
        id: 'item-oil',
        name: 'Cold-Pressed Olive Oil',
        category: 'pantry',
        quantity: 500,
        unit: 'ml',
        expiryDate: addHours(24 * 120),
        daysUntilExpiry: 120,
        isExpiringUrgent: false,
        estimatedCostUsd: 9.99
      },
      {
        id: 'item-garam-masala',
        name: 'Organic Garam Masala',
        category: 'spices',
        quantity: 75,
        unit: 'g',
        expiryDate: addHours(24 * 90),
        daysUntilExpiry: 90,
        isExpiringUrgent: false,
        estimatedCostUsd: 3.99
      },
      {
        id: 'item-tomatoes',
        name: 'Vine-Ripened Tomatoes',
        category: 'produce',
        quantity: 400,
        unit: 'g',
        expiryDate: addHours(24 * 5),
        daysUntilExpiry: 5,
        isExpiringUrgent: false,
        estimatedCostUsd: 2.8
      },
      {
        id: 'item-onions',
        name: 'Yellow Cooking Onions',
        category: 'produce',
        quantity: 500,
        unit: 'g',
        expiryDate: addHours(24 * 7),
        daysUntilExpiry: 7,
        isExpiringUrgent: false,
        estimatedCostUsd: 2.1
      }
    ],
    carts: {},
    timers: []
  };
}

class KitchenDatabase {
  private data: DatabaseSchema;

  constructor() {
    this.data = this.loadState();
  }

  /** Loads state from disk or initializes with default seed data */
  private loadState(): DatabaseSchema {
    try {
      if (fs.existsSync(DB_FILE_PATH)) {
        const raw = fs.readFileSync(DB_FILE_PATH, 'utf-8');
        return JSON.parse(raw) as DatabaseSchema;
      }
    } catch (err) {
      console.warn('[KitchenDatabase] Could not read existing state file, initializing fresh seed.', err);
    }
    const seed = createDefaultSeed();
    this.persist(seed);
    return seed;
  }

  /** Synchronously writes state to disk atomically */
  private persist(dataToSave: DatabaseSchema = this.data): void {
    try {
      const tempPath = `${DB_FILE_PATH}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(dataToSave, null, 2), 'utf-8');
      fs.renameSync(tempPath, DB_FILE_PATH);
    } catch (err) {
      console.error('[KitchenDatabase] Failed to write database state to disk:', err);
    }
  }

  // ==========================================================================
  // Household Profile & Memory (hearth://household/memory)
  // ==========================================================================

  public getHouseholdProfile(householdId: string): HouseholdProfile {
    if (this.data.household.householdId === householdId) {
      return this.data.household;
    }
    // Return current profile if matched or as default household fallback
    return this.data.household;
  }

  public updateHouseholdProfile(updates: Partial<HouseholdProfile> & { householdId: string }): HouseholdProfile {
    this.data.household = {
      ...this.data.household,
      ...updates,
      lastActiveSession: new Date().toISOString()
    };
    this.persist();
    return this.data.household;
  }

  // ==========================================================================
  // Pantry Inventory (sync_pantry_inventory tool)
  // ==========================================================================

  public getPantryItems(): PantryItem[] {
    return this.data.pantry;
  }

  public syncPantryInventory(
    action: 'list' | 'upsert' | 'consume',
    items?: Partial<PantryItem>[]
  ): { items: PantryItem[]; urgentCount: number } {
    if (action === 'upsert' && items && items.length > 0) {
      for (const item of items) {
        const existingIdx = this.data.pantry.findIndex((p) => p.name.toLowerCase() === item.name?.toLowerCase());
        if (existingIdx >= 0) {
          this.data.pantry[existingIdx] = {
            ...this.data.pantry[existingIdx],
            ...item
          } as PantryItem;
        } else {
          this.data.pantry.push({
            id: item.id || `item-${crypto.randomUUID().slice(0, 8)}`,
            name: item.name || 'Unnamed Grocery Item',
            category: item.category || 'pantry',
            quantity: item.quantity ?? 1,
            unit: item.unit || 'units',
            expiryDate: item.expiryDate || new Date(Date.now() + 86400000 * 7).toISOString().split('T')[0],
            daysUntilExpiry: item.daysUntilExpiry ?? 7,
            isExpiringUrgent: item.isExpiringUrgent ?? false,
            estimatedCostUsd: item.estimatedCostUsd ?? 2.5
          });
        }
      }
      this.persist();
    } else if (action === 'consume' && items && items.length > 0) {
      for (const item of items) {
        if (!item.name) continue;
        const idx = this.data.pantry.findIndex((p) => p.name.toLowerCase() === item.name?.toLowerCase());
        if (idx >= 0) {
          const current = this.data.pantry[idx];
          const consumeQty = item.quantity ?? current.quantity;
          if (current.quantity - consumeQty <= 0) {
            this.data.pantry.splice(idx, 1);
          } else {
            current.quantity -= consumeQty;
          }
        }
      }
      this.persist();
    }

    const urgentCount = this.data.pantry.filter((p) => p.isExpiringUrgent).length;
    return { items: this.data.pantry, urgentCount };
  }

  // ==========================================================================
  // Curated Zero-Waste High-Protein Recipes (plan_expiry_meals tool)
  // ==========================================================================

  public getRecipes(): RecipeMealCard[] {
    return [
      {
        id: 'recipe-saag-paneer',
        title: 'Nut-Free High-Protein Saag Paneer with Basmati Rice',
        description: 'Tender artisanal paneer seared in spiced pureed baby spinach and warm cumin, served over fragrant basmati.',
        servings: 2,
        prepMinutes: 10,
        cookMinutes: 20,
        ingredients: [
          { name: 'Organic Baby Spinach', requiredQuantity: 250, unit: 'g', inPantry: true, pantryItemId: 'item-spinach' },
          { name: 'Fresh Artisanal Paneer', requiredQuantity: 300, unit: 'g', inPantry: true, pantryItemId: 'item-paneer' },
          { name: 'Yellow Cooking Onions', requiredQuantity: 150, unit: 'g', inPantry: true, pantryItemId: 'item-onions' },
          { name: 'Vine-Ripened Tomatoes', requiredQuantity: 200, unit: 'g', inPantry: true, pantryItemId: 'item-tomatoes' },
          { name: 'Organic Garam Masala', requiredQuantity: 10, unit: 'g', inPantry: true, pantryItemId: 'item-garam-masala' },
          { name: 'Aged Basmati Rice', requiredQuantity: 180, unit: 'g', inPantry: true, pantryItemId: 'item-rice' },
          // Missing grocery items that will be staged in the cart:
          { name: 'Roasted Pumpkin Seeds (Nut-Free Garnish)', requiredQuantity: 60, unit: 'g', inPantry: false },
          { name: 'Fresh Coriander / Cilantro', requiredQuantity: 1, unit: 'bunch', inPantry: false }
        ],
        nutritionPerServing: {
          proteinGrams: 34,
          calories: 520,
          carbsGrams: 42,
          fatGrams: 24
        },
        estimatedCostPerServingUsd: 4.85,
        usesExpiringItems: ['Organic Baby Spinach', 'Fresh Artisanal Paneer'],
        instructions: [
          'Blanch the expiring spinach for 90 seconds, then blend with garlic and ginger until smooth.',
          'Pan-sear paneer cubes in olive oil until golden brown on all sides (5 mins).',
          'Sauté chopped onions and tomatoes with garam masala, fold in spinach puree and paneer, and simmer.',
          'Top with roasted pumpkin seeds for crunch and serve hot with basmati rice.'
        ],
        timers: [
          { stepNumber: 1, burnerName: 'Rear Left Burner', durationMinutes: 2, instruction: 'Spinach blanching' },
          { stepNumber: 2, burnerName: 'Front Right Burner', durationMinutes: 5, instruction: 'Paneer searing' },
          { stepNumber: 3, burnerName: 'Main Simmer Burner', durationMinutes: 12, instruction: 'Curry simmer & blend' }
        ]
      },
      {
        id: 'recipe-greek-spinach-bowl',
        title: 'High-Protein Whipped Yogurt & Warm Spiced Spinach Bowl',
        description: 'Velvety whipped Greek yogurt layered with warm garlic sautéed spinach, blistered tomatoes, and crisp herbs.',
        servings: 2,
        prepMinutes: 8,
        cookMinutes: 10,
        ingredients: [
          { name: 'Plain Whole Milk Greek Yogurt', requiredQuantity: 400, unit: 'g', inPantry: true, pantryItemId: 'item-yogurt' },
          { name: 'Organic Baby Spinach', requiredQuantity: 150, unit: 'g', inPantry: true, pantryItemId: 'item-spinach' },
          { name: 'Vine-Ripened Tomatoes', requiredQuantity: 150, unit: 'g', inPantry: true, pantryItemId: 'item-tomatoes' },
          { name: 'Cold-Pressed Olive Oil', requiredQuantity: 30, unit: 'ml', inPantry: true, pantryItemId: 'item-oil' },
          // Missing grocery items:
          { name: 'Whole Wheat Warm Pita Pockets', requiredQuantity: 4, unit: 'pieces', inPantry: false },
          { name: 'Sumac Spice Blend', requiredQuantity: 15, unit: 'g', inPantry: false }
        ],
        nutritionPerServing: {
          proteinGrams: 28,
          calories: 390,
          carbsGrams: 32,
          fatGrams: 16
        },
        estimatedCostPerServingUsd: 3.4,
        usesExpiringItems: ['Plain Whole Milk Greek Yogurt', 'Organic Baby Spinach'],
        instructions: [
          'Whip Greek yogurt with sea salt, olive oil, and crushed garlic until light and airy.',
          'Quickly wilt baby spinach in olive oil with cumin and blistered tomatoes (3 mins).',
          'Spoon warm greens over chilled whipped yogurt and serve with toasted pita.'
        ],
        timers: [
          { stepNumber: 1, burnerName: 'Front Burner', durationMinutes: 3, instruction: 'Spinach wilting' },
          { stepNumber: 2, burnerName: 'Toaster / Oven', durationMinutes: 4, instruction: 'Pita warming' }
        ]
      }
    ];
  }

  // ==========================================================================
  // Smart Cart & Checkout (optimize_smart_cart & authorize_checkout)
  // ==========================================================================

  public saveCart(cart: SmartCart): SmartCart {
    this.data.carts[cart.id] = cart;
    this.data.household.activeCartId = cart.id;
    this.persist();
    return cart;
  }

  public getCart(cartId?: string): SmartCart | null {
    if (!cartId) {
      const activeId = this.data.household.activeCartId;
      if (activeId && this.data.carts[activeId]) {
        return this.data.carts[activeId];
      }
      return null;
    }
    return this.data.carts[cartId] || null;
  }

  public authorizeCheckout(
    householdId: string,
    cartId: string,
    userConfirmationToken: string
  ): { success: boolean; orderId: string; totalChargedUsd: number; newBudgetRemaining: number; restockEta: string } {
    const cart = this.getCart(cartId);
    if (!cart) {
      throw new Error(`Cart ${cartId} not found`);
    }

    if (!userConfirmationToken || userConfirmationToken.trim().length === 0) {
      throw new Error('Explicit user confirmation token is required to authorize grocery checkout.');
    }

    if (cart.totalCostUsd > this.data.household.budgetRemainingUsd) {
      throw new Error(
        `Cart total ($${cart.totalCostUsd.toFixed(2)}) exceeds remaining weekly budget ($${this.data.household.budgetRemainingUsd.toFixed(2)}).`
      );
    }

    // Deduct from budget ceiling
    this.data.household.budgetRemainingUsd = parseFloat(
      Math.max(0, this.data.household.budgetRemainingUsd - cart.totalCostUsd).toFixed(2)
    );

    cart.status = 'authorized';
    cart.userConfirmationToken = userConfirmationToken;

    const orderId = `AMZN-ECHO-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const eta = new Date(Date.now() + 2 * 60 * 60 * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Restock the purchased items into pantry
    for (const item of cart.items) {
      this.syncPantryInventory('upsert', [
        {
          name: item.name,
          category: 'pantry',
          quantity: item.quantity,
          unit: item.unit,
          estimatedCostUsd: item.priceUsd,
          isExpiringUrgent: false,
          daysUntilExpiry: 14
        }
      ]);
    }

    this.persist();

    return {
      success: true,
      orderId,
      totalChargedUsd: cart.totalCostUsd,
      newBudgetRemaining: this.data.household.budgetRemainingUsd,
      restockEta: `Today by ${eta}`
    };
  }

  // ==========================================================================
  // Kitchen Timers (stage_kitchen_timers)
  // ==========================================================================

  public getTimers(): ActiveKitchenTimer[] {
    return this.data.timers;
  }

  public stageTimers(recipeId: string, steps: CookingTimerStep[]): ActiveKitchenTimer[] {
    this.data.timers = steps.map((s, idx) => ({
      timerId: `timer-${recipeId}-${idx + 1}`,
      recipeId,
      burnerName: s.burnerName,
      label: s.instruction,
      durationSeconds: s.durationMinutes * 60,
      remainingSeconds: s.durationMinutes * 60,
      status: 'running'
    }));
    this.persist();
    return this.data.timers;
  }

  public updateTimer(timerId: string, action: 'start' | 'pause' | 'dismiss'): ActiveKitchenTimer[] {
    if (action === 'dismiss') {
      this.data.timers = this.data.timers.filter((t) => t.timerId !== timerId);
    } else {
      const timer = this.data.timers.find((t) => t.timerId === timerId);
      if (timer) {
        timer.status = action === 'start' ? 'running' : 'paused';
      }
    }
    this.persist();
    return this.data.timers;
  }
}

// Export singleton database instance
export const db = new KitchenDatabase();
