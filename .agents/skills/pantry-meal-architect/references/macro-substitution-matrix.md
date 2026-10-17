# Macro Substitution Matrix & Allergen-Safe Swaps Reference

<!--
  This reference file is part of the pantry-meal-architect Agent Skill.
  It offloads deterministic nutritional swap calculations and allergen rules
  from the main SKILL.md body, adhering to the 3-stage progressive disclosure standard.
  It is a universal domain reference applicable across any household inventory.
-->

## Overview
When orchestrating recipes from expiring ingredients, household dietary boundaries (e.g., nut allergies, vegetarian macros) often clash with conventional recipes. This matrix specifies tested culinary substitutions that preserve protein density while removing allergens and lowering unit costs.

---

## 1. Nut-Free & Allergen-Safe Swaps (Universal Categories)

| Original Ingredient | Allergy / Restriction | Recommended Safe Swap | Macro Impact (per 100g) | Price Comparison | Culinary & Texture Ratio |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Pine Nuts** | Tree Nut Allergy | **Roasted Pumpkin Seeds (Pepitas)** | +19g Protein, -18g Fat | **$1.80/100g** vs $9.90/100g (Save **$8.10**) | 1:1 replacement; identical crunch and earthy savory notes when toasted. |
| **Walnuts / Cashews** | Tree Nut Allergy | **Roasted Sunflower Seeds** | +21g Protein, -12g Fat | **$0.95/100g** vs $4.50/100g (Save **$3.55**) | 1:1 ratio in pestos, dressings, or hot curries; blend with olive oil for creaminess. |
| **Peanut Butter** | Peanut Allergy | **Sunflower Seed Butter (SunButter)** | +17g Protein, -6g Saturated Fat | **$1.10/100g** vs $0.85/100g (+ $0.25) | 1:1 ratio in marinades, sauces, or oatmeal; allergen-safe school/home compliance. |
| **Almond Flour** | Tree Nut Allergy | **Oat Flour or Chickpea Flour** | +22g Protein (Chickpea), +10g Fiber | **$0.65/100g** vs $2.80/100g (Save **$2.15**) | 1:1 ratio for binding patties or savory baking; chickpea flour boosts iron & folate. |

---

## 2. High-Protein Dairy & Vegetarian Swaps

| Expiring Item | Goal / Constraint | Recommended Swap | Macro Impact (per 100g) | Usage Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Heavy Cream (Liquid)** | Lower Fat / Higher Protein | **Plain Greek Yogurt (0% or 2%)** | +10g Protein, -30g Saturated Fat | Whisk into curries, soups, or sauces off heat to prevent curdling. |
| **Ricotta Cheese** | Higher Protein Ratio | **Whipped Artisanal Paneer or Cottage Cheese** | +18g Protein, -8g Fat | Blend until silky with sea salt and lemon juice; excellent base for roasted greens. |
| **Mayonnaise / Sour Cream** | High-Calorie Condiment | **Greek Yogurt Garlic Aioli** | +9g Protein, -55g Fat | Fold in minced raw garlic, fresh dill, and sea salt. |
| **Ground Meat** | Vegetarian High-Protein | **Crumbled Seared Paneer + Lentils** | 22g Protein/serving | Golden pan-sear gives caramelized texture without animal meat. |

---

## 3. Universal Perishable Food Category Pairing Techniques

When an item is flagged with `isExpiringUrgent: true` (<48 hours to expiry), the agent maps its category to these culinary rescue techniques:

### A. Tender Leafy Greens (Spinach, Kale, Swiss Chard, Arugula, Bok Choy)
- **High-Heat Flash Wilt (2–3 mins):** Sauté in oil with alliums, cumin, or chili flakes; shrinks volume by 80%, perfect for mixing into grain bowls or scrambled eggs.
- **Silk Puree (Blanch & Blend):** 90-second salt-water blanch, cold shock, blend into curry bases, pestos, or pasta sauces.
- **Broth Immersion:** Stir directly into hot soups, stews, or dal during the final 60 seconds off heat.

### B. Fresh Soft & Semi-Firm Cheeses / Curd Proteins (Paneer, Tofu, Halloumi, Queso Blanco)
- **High-Temperature Pan Sear (4–5 mins):** Sear dry cubes in cast iron until deeply golden; develops Maillard browning without melting.
- **Simmer Poach:** Add unseared cubes into simmering sauce (curry, marinara, or miso broth) 4 minutes before serving for soft, tender mouthfeel.
- **Shredded / Crumbled Protein Fold:** Grate into fillings for stuffed flatbreads, enchiladas, or baked casseroles.

### C. Cultured & High-Protein Dairy / Plant Bases (Greek Yogurt, Skyr, Coconut Yogurt, Silken Tofu)
- **Savory Whipped Bed:** Whip with sea salt, lemon juice, and roasted garlic; spread across wide dinner bowls as a high-protein base beneath warm spiced vegetables.
- **Tenderizing Marinade:** Coat vegetables, tofu, or proteins with yogurt and spices for 15–30 minutes before roasting (lactic acid tenderizes while locking in moisture).
- **Enriched Curry Finisher:** Whisk off heat into sauces at the end of cooking to add velvety richness without splitting.

### D. Solanaceae & Juicy Nightshades (Tomatoes, Bell Peppers, Zucchini, Eggplant)
- **Blister / Char (5–8 mins):** High heat blistering in olive oil to concentrate sugars and build smoky depth.
- **Sauce Reduction:** Coarsely dice and simmer with aromatics until juices reduce into a thick savory glaze.

### E. Cruciferous & Hardy Stems (Broccoli, Cauliflower, Cabbage, Brussels Sprouts)
- **Caramelized Sheet-Pan Roast (425°F / 220°C for 15 mins):** High dry heat removes sulfur notes, yielding sweet, nutty crispy edges.
- **Raw Ribbon Slaw:** Finely shave and toss with acid (lemon, vinegar) and seed butter dressing to break down tough cellulose fibers.

### F. Lean Proteins (Poultry, Fish, Legumes, Tempeh)
- **Fast Pan-Glaze:** Sauté bite-sized pieces with ginger, garlic, and citrus/soy glaze (6–8 mins).
- **One-Pot Stew / Dal:** Simmer with dried lentils, tomatoes, and warming spices for maximum protein extraction.

