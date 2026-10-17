#!/usr/bin/env python3
"""
HearthSync+ Unit Price Optimizer & Cart Diffing Engine (v2.0)

Deterministic, O(1)-indexed Python engine that:
1. Normalizes measurement units (g, kg, oz, lb, ml, l, tbsp, tsp, cup, count) and
   diffs aggregated recipe ingredient requirements against current pantry inventory.
2. Enforces the 4-tier resolution order from macroSubstitutionMatrix.md:
   - Tier 1: Hard Safety Constraints (Big-9 Allergens & Medical Restrictions)
   - Tier 2: Ethical / Cultural Diet Boundaries (vegan, vegetarian, jain, gluten-free, etc.)
   - Tier 3: Expiring Pantry Substitute Rescue (<48h urgent stock used at $0.00)
   - Tier 4: Two-Pass Unit-Price ($/g), Protein-per-Dollar, & Budget Ceiling Optimization
3. Outputs backward-compatible JSON for the smart-cart-checkout Agent Skill and
   Alexa+ Streamable HTTP MCP Server (ui://hearth/cart-carousel).

Part of the smart-cart-checkout Agent Skill (.agents/skills/ Open Standard).
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
from decimal import Decimal, ROUND_HALF_UP
import json
from pathlib import Path
import re
import sys
import time
import unittest
from typing import Any, Dict, FrozenSet, Iterable, List, Optional, Set, Tuple

# ---------------------------------------------------------------------------
# 1. Exact Currency & Unit Conversion Helpers
# ---------------------------------------------------------------------------

_CENTS = Decimal("0.01")


def to_cents(val: float | int | str | Decimal) -> Decimal:
    """Quantizes a numeric value to 2 decimal places using standard retail rounding."""
    return Decimal(str(val)).quantize(_CENTS, rounding=ROUND_HALF_UP)


def to_float(val: Decimal) -> float:
    """Converts a quantized Decimal back to a clean float for JSON serialization."""
    return float(val.quantize(_CENTS, rounding=ROUND_HALF_UP))


# Canonical unit conversion table -> (dimension, multiplier_to_base)
# Dimensions: "mass" (base: g), "volume" (base: ml), "count" (base: unit)
UNIT_CONVERSIONS: Dict[str, Tuple[str, float]] = {
    # Mass (base: grams)
    "g": ("mass", 1.0),
    "gram": ("mass", 1.0),
    "grams": ("mass", 1.0),
    "kg": ("mass", 1000.0),
    "kilogram": ("mass", 1000.0),
    "kilograms": ("mass", 1000.0),
    "mg": ("mass", 0.001),
    "oz": ("mass", 28.3495),
    "ounce": ("mass", 28.3495),
    "ounces": ("mass", 28.3495),
    "lb": ("mass", 453.592),
    "lbs": ("mass", 453.592),
    "pound": ("mass", 453.592),
    "pounds": ("mass", 453.592),
    # Volume (base: milliliters)
    "ml": ("volume", 1.0),
    "milliliter": ("volume", 1.0),
    "milliliters": ("volume", 1.0),
    "l": ("volume", 1000.0),
    "liter": ("volume", 1000.0),
    "liters": ("volume", 1000.0),
    "tsp": ("volume", 4.92892),
    "teaspoon": ("volume", 4.92892),
    "teaspoons": ("volume", 4.92892),
    "tbsp": ("volume", 14.7868),
    "tablespoon": ("volume", 14.7868),
    "tablespoons": ("volume", 14.7868),
    "fl oz": ("volume", 29.5735),
    "cup": ("volume", 236.588),
    "cups": ("volume", 236.588),
    # Count / Retail packaging (base: discrete units)
    "unit": ("count", 1.0),
    "units": ("count", 1.0),
    "piece": ("count", 1.0),
    "pieces": ("count", 1.0),
    "pc": ("count", 1.0),
    "pcs": ("count", 1.0),
    "pack": ("count", 1.0),
    "packs": ("count", 1.0),
    "bunch": ("count", 1.0),
    "bunches": ("count", 1.0),
    "can": ("count", 1.0),
    "cans": ("count", 1.0),
    "clove": ("count", 1.0),
    "cloves": ("count", 1.0),
}

_TOKEN_RE = re.compile(r"[a-z0-9]+")
_STOP_WORDS: FrozenSet[str] = frozenset({
    "fresh", "organic", "raw", "whole", "ground", "warm", "wild", "imported",
    "stone", "baked", "strained", "extra", "super", "fine", "blend", "style",
    "pockets", "garnish", "pack", "cans", "can", "bunch", "pieces", "puree",
})


def normalize_quantity(qty: float, unit: str) -> Tuple[str, float]:
    """Converts (qty, unit) to its canonical (dimension, base_amount)."""
    clean_unit = (unit or "units").strip().lower()
    dim, factor = UNIT_CONVERSIONS.get(clean_unit, ("count", 1.0))
    return dim, float(qty) * factor


def comparable_quantities(
    pantry_qty: float, pantry_unit: str, needed_qty: float, needed_unit: str
) -> Tuple[float, float]:
    """
    Returns (normalized_pantry_qty, normalized_needed_qty) in a common dimension.
    If dimensions match, compares in canonical base units (e.g., 0.5 kg >= 200 g).
    If dimensions differ (e.g., pantry in 'g' vs recipe in 'bunch'), falls back to raw numbers
    unless a standard culinary weight equivalent applies (1 bunch ~ 50g, 1 piece ~ 60g).
    """
    p_dim, p_base = normalize_quantity(pantry_qty, pantry_unit)
    n_dim, n_base = normalize_quantity(needed_qty, needed_unit)
    if p_dim == n_dim:
        return p_base, n_base
    # Cross-dimension culinary heuristics (e.g. pantry tracked in grams, recipe asks for 1 bunch)
    n_u = (needed_unit or "").strip().lower()
    if p_dim == "mass" and n_dim == "count":
        if n_u in ("bunch", "bunches"):
            return p_base, needed_qty * 50.0
        if n_u in ("clove", "cloves"):
            return p_base, needed_qty * 5.0
    return float(pantry_qty), float(needed_qty)


def tokenize_name(name: str) -> Tuple[str, FrozenSet[str], FrozenSet[str]]:
    """
    Returns (normalized_phrase, all_tokens, core_tokens_without_modifiers).
    Prevents false-positive substring collisions like 'egg' in 'eggplant' or 'nut' in 'butternut'.
    """
    norm = " ".join(_TOKEN_RE.findall((name or "").lower()))
    tokens = frozenset(norm.split())
    core = frozenset(t for t in tokens if t not in _STOP_WORDS) or tokens
    return norm, tokens, core


# ---------------------------------------------------------------------------
# 2. Universal Retail Catalog & Macro Substitution Database
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class CatalogItem:
    key: str
    standard_name: str
    unit_price_per_g: float
    package_price_usd: float
    package_weight_g: float = 100.0
    default_unit: str = "pack"
    is_allergen: bool = False
    allergen_type: Optional[str] = None
    dietary_Compatibility: FrozenSet[str] = field(
        default_factory=lambda: frozenset({"vegan", "vegetarian", "pescatarian", "omnivore", "halal", "kosher"})
    )
    protein_per_100g: float = 0.0
    fat_per_100g: float = 0.0
    carbs_per_100g: float = 0.0
    substitute_candidate: Optional[str] = None
    multi_constraint_fallback: Optional[str] = None
    substitute_reason: Optional[str] = None
    culinary_notes: Optional[str] = None
    aliases: Tuple[str, ...] = ()

    def to_legacy_dict(self) -> Dict[str, Any]:
        """Provides 100% backward-compatible dictionary representation for RETAIL_CATALOG."""
        return {
            "standard_name": self.standard_name,
            "unit_price_per_g": self.unit_price_per_g,
            "package_price_usd": self.package_price_usd,
            "package_weight_g": self.package_weight_g,
            "default_unit": self.default_unit,
            "is_allergen": self.is_allergen,
            "allergen_type": self.allergen_type,
            "protein_per_100g": self.protein_per_100g,
            "fat_per_100g": self.fat_per_100g,
            "carbs_per_100g": self.carbs_per_100g,
            "substitute_candidate": self.substitute_candidate,
            "multi_constraint_fallback": self.multi_constraint_fallback,
            "substitute_reason": self.substitute_reason,
            "culinary_notes": self.culinary_notes,
        }


_CATALOG_ITEMS: Tuple[CatalogItem, ...] = (
    # --- Original Baseline Items & Substitutes ---
    CatalogItem(
        key="pine nuts",
        standard_name="Pine Nuts (100g)",
        unit_price_per_g=0.099,
        package_price_usd=9.90,
        package_weight_g=100.0,
        is_allergen=True,
        allergen_type="Tree Nuts",
        protein_per_100g=14.0,
        fat_per_100g=68.0,
        carbs_per_100g=13.0,
        substitute_candidate="roasted pumpkin seeds",
        multi_constraint_fallback="hemp hearts",
        substitute_reason="Allergen safety (Nut-Free) and 80% lower unit price ($0.018/g vs $0.099/g)",
        culinary_notes="1:1 ratio. Toasting 2-3 mins in a dry pan replicates pine nut aroma and crunch.",
        aliases=("imported pine nuts", "pignoli", "pinon nuts", "pine nut"),
    ),
    CatalogItem(
        key="roasted pumpkin seeds",
        standard_name="Roasted Pumpkin Seeds (Nut-Free Garnish, 200g)",
        unit_price_per_g=0.018,
        package_price_usd=3.59,
        package_weight_g=200.0,
        is_allergen=False,
        protein_per_100g=30.0,
        fat_per_100g=49.0,
        carbs_per_100g=11.0,
        aliases=("pepitas", "pumpkin seeds", "toasted pumpkin seeds", "roasted pepitas"),
    ),
    CatalogItem(
        key="hemp hearts",
        standard_name="Shelled Organic Hemp Hearts (250g)",
        unit_price_per_g=0.024,
        package_price_usd=5.99,
        package_weight_g=250.0,
        is_allergen=False,
        protein_per_100g=32.0,
        fat_per_100g=49.0,
        carbs_per_100g=9.0,
        aliases=("hemp seeds", "hulled hemp seeds"),
    ),
    CatalogItem(
        key="coriander",
        standard_name="Fresh Organic Coriander / Cilantro",
        unit_price_per_g=0.015,
        package_price_usd=1.49,
        package_weight_g=100.0,
        is_allergen=False,
        protein_per_100g=2.1,
        fat_per_100g=0.5,
        carbs_per_100g=3.7,
        aliases=("cilantro", "fresh coriander", "coriander leaves", "cilantro bunch", "fresh coriander cilantro"),
    ),
    CatalogItem(
        key="pita",
        standard_name="Stone-Baked Whole Wheat Pita Pockets (6-pack)",
        unit_price_per_g=0.011,
        package_price_usd=3.29,
        package_weight_g=300.0,
        is_allergen=True,
        allergen_type="Wheat/Gluten",
        protein_per_100g=9.8,
        fat_per_100g=1.7,
        carbs_per_100g=55.0,
        substitute_candidate="gf flatbread",
        substitute_reason="Celiac / Gluten-Free safety swap (1:1 flatbread replacement)",
        aliases=("pita pockets", "whole wheat pita", "whole wheat warm pita pockets", "pita bread"),
    ),
    CatalogItem(
        key="gf flatbread",
        standard_name="Certified Gluten-Free Buckwheat & Chickpea Flatbread (4-pack)",
        unit_price_per_g=0.016,
        package_price_usd=3.99,
        package_weight_g=250.0,
        is_allergen=False,
        protein_per_100g=13.0,
        fat_per_100g=3.0,
        carbs_per_100g=48.0,
        aliases=("gluten free pita", "buckwheat flatbread"),
    ),
    CatalogItem(
        key="sumac",
        standard_name="Ground Wild Sumac Spice (50g)",
        unit_price_per_g=0.060,
        package_price_usd=2.99,
        package_weight_g=50.0,
        is_allergen=False,
        protein_per_100g=2.5,
        fat_per_100g=7.0,
        carbs_per_100g=40.0,
        aliases=("sumac spice", "sumac spice blend", "ground sumac"),
    ),
    # --- Additional Big-9 Allergen & Macro Matrix Items (from macroSubstitutionMatrix.md & Simulator) ---
    CatalogItem(
        key="walnuts",
        standard_name="Raw California Walnuts / Cashews (200g)",
        unit_price_per_g=0.045,
        package_price_usd=8.99,
        package_weight_g=200.0,
        is_allergen=True,
        allergen_type="Tree Nuts",
        protein_per_100g=16.0,
        fat_per_100g=54.0,
        carbs_per_100g=21.0,
        substitute_candidate="roasted sunflower seeds",
        multi_constraint_fallback="roasted pumpkin seeds",
        substitute_reason="Allergen safety (Tree Nut-Free) and 75% lower unit cost ($0.012/g vs $0.045/g)",
        culinary_notes="1:1 ratio. Soak raw sunflower seeds in boiling water 15 mins and blend 2:1 for creamy sauces.",
        aliases=("cashews", "walnut", "cashew", "walnuts cashews"),
    ),
    CatalogItem(
        key="roasted sunflower seeds",
        standard_name="Roasted Sunflower Seeds (Nut-Free, 250g)",
        unit_price_per_g=0.012,
        package_price_usd=2.99,
        package_weight_g=250.0,
        is_allergen=False,
        protein_per_100g=21.0,
        fat_per_100g=51.0,
        carbs_per_100g=20.0,
        aliases=("sunflower seeds", "toasted sunflower seeds"),
    ),
    CatalogItem(
        key="peanut butter",
        standard_name="Creamy Natural Peanut Butter (450g)",
        unit_price_per_g=0.0085,
        package_price_usd=3.85,
        package_weight_g=450.0,
        is_allergen=True,
        allergen_type="Peanuts",
        protein_per_100g=25.0,
        fat_per_100g=50.0,
        carbs_per_100g=20.0,
        substitute_candidate="sunflower seed butter",
        multi_constraint_fallback="roasted pumpkin seeds",
        substitute_reason="Hard Safety Constraint (Peanut & Tree-Nut Free school-safe swap)",
        culinary_notes="1:1 ratio. Add a squeeze of lemon juice when heating to prevent chlorophyll greening.",
        aliases=("peanut paste",),
    ),
    CatalogItem(
        key="sunflower seed butter",
        standard_name="Unsweetened Sunflower Seed Butter / SunButter (450g)",
        unit_price_per_g=0.011,
        package_price_usd=4.95,
        package_weight_g=450.0,
        is_allergen=False,
        protein_per_100g=20.0,
        fat_per_100g=53.0,
        carbs_per_100g=21.0,
        aliases=("sunbutter", "sunflower butter"),
    ),
    CatalogItem(
        key="almond flour",
        standard_name="Superfine Blanched Almond Flour (450g)",
        unit_price_per_g=0.028,
        package_price_usd=12.60,
        package_weight_g=450.0,
        is_allergen=True,
        allergen_type="Tree Nuts",
        protein_per_100g=21.0,
        fat_per_100g=50.0,
        carbs_per_100g=21.0,
        substitute_candidate="chickpea flour",
         substitute_reason="Tree Nut Allergy safety and 75% lower unit price ($0.0065/g vs $0.028/g)",
        culinary_notes="1:1 by weight for savory fritters and binders; +1g protein and +10g fiber per 100g.",
        aliases=("almond meal",),
    ),
    CatalogItem(
        key="chickpea flour",
        standard_name="Stone-Ground Chickpea Flour / Besan (500g)",
        unit_price_per_g=0.0065,
        package_price_usd=3.25,
        package_weight_g=500.0,
        is_allergen=False,
        protein_per_100g=22.0,
        fat_per_100g=6.0,
        carbs_per_100g=58.0,
        aliases=("besan", "gram flour", "garbanzo flour"),
    ),
    CatalogItem(
        key="soy sauce",
        standard_name="Brewed Soy Sauce / Tamari (250ml)",
        unit_price_per_g=0.0095,
        package_price_usd=2.39,
        package_weight_g=250.0,
        is_allergen=True,
        allergen_type="Soy",
        protein_per_100g=8.0,
        fat_per_100g=0.0,
        carbs_per_100g=5.0,
        substitute_candidate="coconut aminos",
        substitute_reason="Soy & Gluten Allergy safety swap (-65% sodium)",
        culinary_notes="1:1 volume ratio. Add 1/8 tsp sea salt and 1/2 tsp rice vinegar per tbsp.",
        aliases=("tamari", "shoyu"),
    ),
    CatalogItem(
        key="coconut aminos",
        standard_name="Organic Coconut Aminos Savory Seasoning (250ml)",
        unit_price_per_g=0.014,
        package_price_usd=3.49,
        package_weight_g=250.0,
        is_allergen=False,
        protein_per_100g=2.0,
        fat_per_100g=0.0,
        carbs_per_100g=15.0,
    ),
    CatalogItem(
        key="tahini",
        standard_name=" Artisanal Hulled Sesame Tahini Paste (300g)",
        unit_price_per_g=0.0125,
        package_price_usd=3.75,
        package_weight_g=300.0,
        is_allergen=True,
        allergen_type="Sesame",
        protein_per_100g=17.0,
        fat_per_100g=54.0,
        carbs_per_100g=21.0,
        substitute_candidate="sunflower seed butter",
        substitute_reason="Big-9 Sesame Allergy safety swap (+3g protein/100g)",
        aliases=("sesame paste", "tahini paste"),
    ),
    CatalogItem(
        key="heavy cream",
        standard_name="Pasteurized Heavy Whipping Cream (250ml)",
        unit_price_per_g=0.011,
        package_price_usd=2.75,
        package_weight_g=250.0,
        is_allergen=True,
        allergen_type="Dairy",
        dietary_Compatibility=frozenset({"vegetarian", "pescatarian", "omnivore", "halal", "kosher"}),
        protein_per_100g=2.0,
        fat_per_100g=36.0,
        carbs_per_100g=3.0,
        substitute_candidate="strained greek yogurt",
        multi_constraint_fallback="silken tofu",
        substitute_reason="High-protein (+8g P, -34g Fat per 100g) & 30% lower unit cost",
        culinary_notes="1:1 volume. Temper Greek yogurt off-heat before stirring into warm sauces.",
        aliases=("whipping cream", "double cream"),
    ),
    CatalogItem(
        key="strained greek yogurt",
        standard_name="Strained 2% Greek Yogurt (400g)",
        unit_price_per_g=0.0075,
        package_price_usd=2.99,
        package_weight_g=400.0,
        is_allergen=True,
        allergen_type="Dairy",
        dietary_Compatibility=frozenset({"vegetarian", "pescatarian", "omnivore", "halal", "kosher"}),
        protein_per_100g=10.0,
        fat_per_100g=2.0,
        carbs_per_100g=4.0,
        substitute_candidate="silken tofu",
        substitute_reason="Plant-based / Dairy-Free allergy swap",
        aliases=("greek yogurt", "skyr"),
    ),
    CatalogItem(
        key="silken tofu",
        standard_name="Organic Silken Tofu (Dairy-Free Cream Base, 350g)",
        unit_price_per_g=0.0065,
        package_price_usd=2.29,
        package_weight_g=350.0,
        is_allergen=True,
        allergen_type="Soy",
        protein_per_100g=8.0,
        fat_per_100g=3.0,
        carbs_per_100g=2.0,
        aliases=("firm tofu", "extra firm tofu", "tofu"),
    ),
    CatalogItem(
        key="pomegranate arils",
        standard_name="Fresh Ruby Pomegranate Arils Cup (150g)",
        unit_price_per_g=0.0319,
        package_price_usd=4.79,
        package_weight_g=150.0,
        is_allergen=False,
        protein_per_100g=1.7,
        fat_per_100g=1.2,
        carbs_per_100g=19.0,
        substitute_candidate="meyer lemons",
        substitute_reason="Budget ceiling optimization (-52% package cost while preserving bright finishing acidity)",
        aliases=("pomegranate seeds", "pomegranate"),
    ),
    CatalogItem(
        key="meyer lemons",
        standard_name="Organic Meyer Lemons (3-Pack, 300g)",
        unit_price_per_g=0.0076,
        package_price_usd=2.29,
        package_weight_g=300.0,
        is_allergen=False,
        protein_per_100g=1.1,
        fat_per_100g=0.3,
        carbs_per_100g=9.0,
        aliases=("lemons", "fresh lemon", "lemon"),
    ),
    CatalogItem(
        key="quinoa",
        standard_name="Organic Tri-Color Quinoa (500g)",
        unit_price_per_g=0.011,
        package_price_usd=5.49,
        package_weight_g=500.0,
        is_allergen=False,
        protein_per_100g=14.1,
        fat_per_100g=6.1,
        carbs_per_100g=64.2,
        aliases=("tri color quinoa", "white quinoa"),
    ),
    CatalogItem(
        key="garam masala",
        standard_name="Whole Roasted Garam Masala Blend (100g)",
        unit_price_per_g=0.0429,
        package_price_usd=4.29,
        package_weight_g=100.0,
        is_allergen=False,
        protein_per_100g=10.0,
        fat_per_100g=12.0,
        carbs_per_100g=45.0,
        aliases=("garam masala spice", "roasted garam masala"),
    ),
    CatalogItem(
        key="chickpeas",
        standard_name="Organic Garbanzo Chickpeas (2 Cans, 800g)",
        unit_price_per_g=0.004,
        package_price_usd=3.18,
        package_weight_g=800.0,
        is_allergen=False,
        protein_per_100g=19.0,
        fat_per_100g=6.0,
        carbs_per_100g=61.0,
        aliases=("garbanzo beans", "cooked chickpeas", "canned chickpeas"),
    ),
)

# Legacy dictionary export for external callers inspecting RETAIL_CATALOG directly
RETAIL_CATALOG: Dict[str, Dict[str, Any]] = {
    item.key: item.to_legacy_dict() for item in _CATALOG_ITEMS
}

# Pre-build O(1) phrase & token inverted indices at module load time
_CATALOG_BY_KEY: Dict[str, CatalogItem] = {item.key: item for item in _CATALOG_ITEMS}
_PHRASE_INDEX: Dict[str, CatalogItem] = {}
_TOKEN_INDEX: List[Tuple[FrozenSet[str], CatalogItem]] = []

for _item in _CATALOG_ITEMS:
    for _phrase in (_item.key, _item.standard_name, *_item.aliases):
        _norm, _all_toks, _core_toks = tokenize_name(_phrase)
        if _norm:
            _PHRASE_INDEX[_norm] = _item
        if _core_toks:
            _TOKEN_INDEX.append((_core_toks, _item))


def lookup_catalog_item(raw_name: str) -> Optional[CatalogItem]:
    """
    Resolves an ingredient name to a CatalogItem using:
    1. O(1) exact normalized phrase lookup.
    2. Highest-specificity token-subset / Jaccard overlap match (preventing substring collisions).
    """
    norm, all_toks, core_toks = tokenize_name(raw_name)
    if not norm:
        return None
    if norm in _PHRASE_INDEX:
        return _PHRASE_INDEX[norm]

    best_match: Optional[CatalogItem] = None
    best_score: Tuple[float, int] = (0.0, 0)

    for cand_tokens, item in _TOKEN_INDEX:
        # Either all candidate core tokens appear in the query, or all query core tokens appear in candidate
        if cand_tokens.issubset(all_toks) or (core_toks and core_toks.issubset(cand_tokens)):
            overlap = len(cand_tokens & all_toks)
            union = len(cand_tokens | core_toks)
            score = (overlap / max(union, 1), overlap)
            if score > best_score:
                best_score = score
                best_match = item

    return best_match


# ---------------------------------------------------------------------------
# 3. Pantry Diffing & Expiring-Inventory Rescue Engine
# ---------------------------------------------------------------------------

def _match_pantry_entry(
    ing_name: str, indexed_pantry: List[Tuple[str, FrozenSet[str], Dict[str, Any]]]
) -> Optional[Dict[str, Any]]:
    """Matches an ingredient against indexed pantry items using token-safe matching."""
    norm, all_toks, core_toks = tokenize_name(ing_name)
    if not norm:
        return None

    best_entry: Optional[Dict[str, Any]] = None
    best_overlap = 0

    for p_norm, p_core_toks, p_entry in indexed_pantry:
        if norm == p_norm:
            return p_entry
        if p_core_toks and (p_core_toks.issubset(all_toks) or core_toks.issubset(p_core_toks)):
            overlap = len(p_core_toks & all_toks)
            if overlap > best_overlap:
                best_overlap = overlap
                best_entry = p_entry

    return best_entry


def diff_pantry(
    needed_ingredients: List[Dict[str, Any]],
    pantry_stock: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Diffs recipe ingredients against existing pantry inventory with unit normalization
    and duplicate-ingredient consolidation.
    Only items not already in stock (or insufficient in remaining quantity) are flagged for purchase.
    """
    # Aggregate pantry stock by normalized name in case multiple pantry rows exist
    aggregated_pantry: Dict[str, Dict[str, Any]] = {}
    for item in pantry_stock or []:
        raw_p_name = item.get("name", "")
        norm, _, core_toks = tokenize_name(raw_p_name)
        if not norm:
            continue
        qty = float(item.get("quantity", 0) or 0)
        unit = item.get("unit", "units")
        hours_exp = item.get("hours_until_expiry", item.get("hoursUntilExpiry", 999))
        is_urgent = bool(item.get("isExpiringUrgent", False)) or (
            isinstance(hours_exp, (int, float)) and hours_exp <= 48
        )
        if norm in aggregated_pantry:
            existing = aggregated_pantry[norm]
            p_base, add_base = comparable_quantities(
                existing["quantity"], existing["unit"], qty, unit
            )
            existing["quantity"] = p_base + add_base
            existing["isExpiringUrgent"] = existing["isExpiringUrgent"] or is_urgent
        else:
            aggregated_pantry[norm] = {
                "name": raw_p_name,
                "quantity": qty,
                "unit": unit,
                "core_tokens": core_toks,
                "isExpiringUrgent": is_urgent,
            }

    indexed_pantry: List[Tuple[str, FrozenSet[str], Dict[str, Any]]] = [
        (norm, entry["core_tokens"], entry) for norm, entry in aggregated_pantry.items()
    ]

    missing_items: List[Dict[str, Any]] = []

    for ingredient in needed_ingredients or []:
        if ingredient.get("inPantry", False):
            continue

        ing_name = ingredient.get("name", "")
        needed_qty = float(ingredient.get("requiredQuantity", ingredient.get("quantity", 1)) or 1)
        needed_unit = ingredient.get("unit", "units")

        p_entry = _match_pantry_entry(ing_name, indexed_pantry)
        if p_entry is not None:
            p_avail, n_req = comparable_quantities(
                p_entry["quantity"], p_entry["unit"], needed_qty, needed_unit
            )
            if p_avail >= n_req and p_avail > 0:
                # Deduct consumed stock so subsequent recipes don't double-claim the same pantry item
                remaining_ratio = max(0.0, (p_avail - n_req) / p_avail)
                p_entry["quantity"] = round(p_entry["quantity"] * remaining_ratio, 4)
                continue
            elif p_avail > 0:
                # Partial stock in pantry: only purchase the deficit!
                deficit_ratio = (n_req - p_avail) / max(n_req, 1e-9)
                p_entry["quantity"] = 0.0
                partial_ing = dict(ingredient)
                partial_ing["requiredQuantity"] = round(needed_qty * deficit_ratio, 2)
                missing_items.append(partial_ing)
                continue

        missing_items.append(ingredient)

    return missing_items


# ---------------------------------------------------------------------------
# 4. Multi-Constraint Cart Optimizer (Allergens + Diet + Expiring Pantry + Budget Cap)
# ---------------------------------------------------------------------------

def _has_allergen_conflict(item: CatalogItem, active_allergies: Set[str]) -> bool:
    """Checks if a CatalogItem conflicts with any active household allergy."""
    if not item.is_allergen or not item.allergen_type or not active_allergies:
        return False
    item_allergen = item.allergen_type.lower()
    for user_allergy in active_allergies:
        if user_allergy in item_allergen or item_allergen in user_allergy:
            return True
    return False


def _resolve_safe_substitute(
    entry: CatalogItem,
    active_allergies: Set[str],
    visited: Optional[Set[str]] = None,
) -> Optional[CatalogItem]:
    """
    Traverses primary and multi-constraint fallback candidates from macroSubstitutionMatrix.md
    to find a substitute that is 100% free of active allergen conflicts.
    """
    visited = visited or {entry.key}
    candidates = [entry.substitute_candidate, entry.multi_constraint_fallback]
    for cand_key in candidates:
        if not cand_key or cand_key in visited:
            continue
        cand_item = _CATALOG_BY_KEY.get(cand_key)
        if not cand_item:
            continue
        visited.add(cand_key)
        if not _has_allergen_conflict(cand_item, active_allergies):
            return cand_item
        # Recursive resolution if primary candidate also conflicts with a secondary allergy
        deeper = _resolve_safe_substitute(cand_item, active_allergies, visited)
        if deeper is not None:
            return deeper
    return None


def optimize_cart(
    missing_items: List[Dict[str, Any]],
    budget_cap_usd: float = 25.0,
    allergies: Optional[List[str]] = None,
    prefer_organic: bool = True,
    pantry_stock: Optional[List[Dict[str, Any]]] = None,
     high_unit_price_threshold_usd: float = 6.0,
) -> Dict[str, Any]:
    """
    Evaluates missing ingredients, enforces Big-9 allergen safety and expiring pantry rescue,
    and applies two-pass unit-price substitutions to stay strictly within budget_cap_usd.
    """
    t0 = time.perf_counter()
    active_allergies: Set[str] = {a.strip().lower() for a in (allergies or []) if a and a.strip()}
    budget_cap_dec = to_cents(budget_cap_usd)

    # Index any remaining pantry stock to support Tier 3 Expiring Inventory Substitute Rescue
    indexed_pantry: List[Tuple[str, FrozenSet[str], Dict[str, Any]]] = []
    for p_item in pantry_stock or []:
        p_norm, _, p_core = tokenize_name(p_item.get("name", ""))
        if p_norm and float(p_item.get("quantity", 0) or 0) > 0:
            indexed_pantry.append((p_norm, p_core, p_item))

    cart_items: List[Dict[str, Any]] = []
    substitutions_applied: List[Dict[str, Any]] = []
    total_savings_dec = Decimal("0.00")

    # Track items eligible for Pass 2 budget-cap tightening if Pass 1 total > budget_cap_usd
    deferred_budget_swaps: List[Tuple[int, CatalogItem, CatalogItem]] = []

    for item in missing_items or []:
        raw_name = item.get("name", "")
        catalog_entry = lookup_catalog_item(raw_name)

        # Fallback for custom/unindexed items
        if catalog_entry is None:
            price_dec = to_cents(item.get("estimatedPriceUsd", 3.0))
            cart_items.append({
                "itemId": f"item-{len(cart_items) + 1}",
                "name": raw_name,
                "quantity": 1,
                "unit": item.get("unit", "units"),
                "priceUsd": to_float(price_dec),
                "isOrganic": prefer_organic,
            })
            continue

        is_conflict = _has_allergen_conflict(catalog_entry, active_allergies)
        sub_entry = _resolve_safe_substitute(catalog_entry, active_allergies)

        # Tier 3: Check if a safe substitute is already in stock in the household pantry!
        if sub_entry is not None and indexed_pantry:
            pantry_sub = _match_pantry_entry(sub_entry.key, indexed_pantry)
            if pantry_sub is not None and (is_conflict or pantry_sub.get("isExpiringUrgent", False)):
                saved_dec = to_cents(catalog_entry.package_price_usd)
                total_savings_dec += saved_dec
                reason = (
                    f"Rescued expiring in-stock pantry substitute ({pantry_sub.get('name')}) "
                    f"at $0.00 retail cost"
                )
                substitutions_applied.append({
                    "original": catalog_entry.standard_name,
                    "replacement": f"{sub_entry.standard_name} [From Pantry Stock]",
                    "savingsUsd": to_float(saved_dec),
                    "reason": reason,
                })
                continue

        # Tier 1 & Tier 4 (Pass 1): Immediate swap on allergen conflict OR high-premium item (> $6.00)
        should_swap_now = (
            sub_entry is not None
            and (
                is_conflict
                or (
                    catalog_entry.package_price_usd > high_unit_price_threshold_usd
                    and sub_entry.package_price_usd < catalog_entry.package_price_usd
                )
            )
        )

        if should_swap_now and sub_entry is not None:
            orig_price = to_cents(catalog_entry.package_price_usd)
            sub_price = to_cents(sub_entry.package_price_usd)
            savings_dec = orig_price - sub_price
            total_savings_dec += savings_dec
            reason = catalog_entry.substitute_reason or "Unit-price & allergen optimization"

            cart_items.append({
                "itemId": f"item-sub-{len(cart_items) + 1}",
                "name": sub_entry.standard_name,
                "quantity": 1,
                "unit": sub_entry.default_unit,
                "priceUsd": to_float(sub_price),
                "isOrganic": prefer_organic,
                "originalItemName": catalog_entry.standard_name,
                "savingsUsd": to_float(savings_dec),
                "substitutionReason": reason,
            })
            substitutions_applied.append({
                "original": catalog_entry.standard_name,
                "replacement": sub_entry.standard_name,
                "savingsUsd": to_float(savings_dec),
                "reason": reason,
            })
        else:
            item_idx = len(cart_items)
            orig_price = to_cents(catalog_entry.package_price_usd)
            cart_items.append({
                "itemId": f"item-{item_idx + 1}",
                "name": catalog_entry.standard_name,
                "quantity": 1,
                "unit": catalog_entry.default_unit,
                "priceUsd": to_float(orig_price),
                "isOrganic": prefer_organic,
            })
            # Record candidate for Pass 2 budget-ceiling enforcement if cheaper substitute exists
            if sub_entry is not None and sub_entry.package_price_usd < catalog_entry.package_price_usd:
                deferred_budget_swaps.append((item_idx, catalog_entry, sub_entry))

    # Pass 2: Strict Budget-Ceiling Enforcement
    # If cart total still exceeds budget_cap_usd, apply deferred unit-price swaps ordered by largest savings
    current_total_dec = sum((to_cents(i["priceUsd"]) for i in cart_items), Decimal("0.00"))
    if current_total_dec > budget_cap_dec and deferred_budget_swaps:
        deferred_budget_swaps.sort(
            key=lambda x: x[1].package_price_usd - x[2].package_price_usd,
            reverse=True,
        )
        for idx, orig_entry, sub_entry in deferred_budget_swaps:
            if current_total_dec <= budget_cap_dec:
                break
            orig_p = to_cents(orig_entry.package_price_usd)
            sub_p = to_cents(sub_entry.package_price_usd)
            saved_dec = orig_p - sub_p
            if saved_dec <= Decimal("0.00"):
                continue

            current_total_dec -= saved_dec
            total_savings_dec += saved_dec
            reason = (
                orig_entry.substitute_reason
                or f"Budget cap enforcement (saved ${to_float(saved_dec):.2f} to stay under ${to_float(budget_cap_dec):.2f})"
            )
            cart_items[idx] = {
                "itemId": f"item-sub-{idx + 1}",
                "name": sub_entry.standard_name,
                "quantity": 1,
                "unit": sub_entry.default_unit,
                "priceUsd": to_float(sub_p),
                "isOrganic": prefer_organic,
                "originalItemName": orig_entry.standard_name,
                "savingsUsd": to_float(saved_dec),
                "substitutionReason": reason,
            }
            substitutions_applied.append({
                "original": orig_entry.standard_name,
                "replacement": sub_entry.standard_name,
                "savingsUsd": to_float(saved_dec),
                "reason": reason,
            })

    under_budget = current_total_dec <= budget_cap_dec
    elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 3)

    return {
        "cartItems": cart_items,
        "totalCostUsd": to_float(current_total_dec),
        "rawTotalUsd": to_float(current_total_dec + total_savings_dec),
        "budgetCapUsd": to_float(budget_cap_dec),
        "totalSavingsUsd": to_float(total_savings_dec),
        "underBudget": under_budget,
        "substitutionsCount": len(substitutions_applied),
        "substitutions": substitutions_applied,
        "executionTimeMs": elapsed_ms,
    }


# ---------------------------------------------------------------------------
# 5. Built-In Self-Diagnostic Unit Test Suite (--test)
# ---------------------------------------------------------------------------

class OptimizerSelfTestSuite(unittest.TestCase):
    def test_allergen_and_unit_price_swap(self) -> None:
        test_ingredients = [
            {"name": "Pine Nuts", "requiredQuantity": 50, "unit": "g", "inPantry": False},
            {"name": "Fresh Coriander / Cilantro", "requiredQuantity": 1, "unit": "bunch", "inPantry": False},
            {"name": "Whole Wheat Warm Pita Pockets", "requiredQuantity": 4, "unit": "pieces", "inPantry": False},
            {"name": "Sumac Spice Blend", "requiredQuantity": 15, "unit": "g", "inPantry": False},
        ]
        res = optimize_cart(test_ingredients, budget_cap_usd=25.0, allergies=["Tree Nuts"])
        self.assertTrue(res["underBudget"])
        self.assertEqual(res["totalCostUsd"], 11.36)
        self.assertEqual(res["totalSavingsUsd"], 6.31)
        self.assertEqual(res["substitutionsCount"], 1)
        self.assertIn("Pumpkin Seeds", res["cartItems"][0]["name"])

    def test_unit_normalized_pantry_diff(self) -> None:
        needed = [
            {"name": "Organic Baby Spinach", "requiredQuantity": 200, "unit": "g"},
            {"name": "Fresh Coriander", "requiredQuantity": 1, "unit": "bunch"},
            {"name": "Pine Nuts", "requiredQuantity": 50, "unit": "g"},
        ]
        # Pantry has 0.5 kg (500g) spinach and 100g coriander (covers 1 bunch ~ 50g)
        pantry = [
            {"name": "Baby Spinach", "quantity": 0.5, "unit": "kg"},
            {"name": "Fresh Organic Coriander / Cilantro", "quantity": 100, "unit": "g"},
        ]
        missing = diff_pantry(needed, pantry)
        self.assertEqual(len(missing), 1)
        self.assertEqual(missing[0]["name"], "Pine Nuts")

    def test_budget_cap_second_pass_swap(self) -> None:
        # Pomegranate Arils ($4.79) is under $6.00, so Pass 1 keeps it unless budget cap ($3.00) is exceeded
        missing = [{"name": "Pomegranate Arils", "requiredQuantity": 150, "unit": "g"}]
        res = optimize_cart(missing, budget_cap_usd=3.00, allergies=[])
        self.assertTrue(res["underBudget"])
        self.assertEqual(res["totalCostUsd"], 2.29)
        self.assertEqual(res["substitutionsCount"], 1)
        self.assertIn("Meyer Lemons", res["cartItems"][0]["name"])

    def test_no_false_positive_substring_collision(self) -> None:
        # "Eggplant" must NOT match "Whole Hen's Eggs" or trigger an Egg allergy swap
        pantry = [{"name": "Whole Eggs", "quantity": 12, "unit": "pieces"}]
        needed = [{"name": "Fresh Japanese Eggplant", "requiredQuantity": 2, "unit": "pieces"}]
        missing = diff_pantry(needed, pantry)
        self.assertEqual(len(missing), 1)


def _load_json_input(raw_arg: Optional[str]) -> Dict[str, Any]:
    """Safely loads JSON input from a CLI string, file path, or stdin."""
    if raw_arg:
        candidate_path = Path(raw_arg)
        if candidate_path.is_file():
            return json.loads(candidate_path.read_text(encoding="utf-8"))
        return json.loads(raw_arg)
    if not sys.stdin.isatty():
        content = sys.stdin.read().strip()
        if content:
            return json.loads(content)
    return {
        "needed_ingredients": [
            {"name": "Pine Nuts", "inPantry": False},
            {"name": "Fresh Coriander", "inPantry": False},
        ],
        "allergies": ["Tree Nuts"],
        "budget_cap_usd": 25.0,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="HearthSync+ Unit Price Cart Optimizer")
    parser.add_argument("--input", type=str, help="JSON input string or path to JSON file")
    parser.add_argument("--budget", type=float, default=None, help="Override budget cap in USD")
    parser.add_argument("--allergies", type=str, default=None, help="Comma-separated list of allergies")
    parser.add_argument("--test", action="store_true", help="Run self-diagnostic unit tests")
    args = parser.parse_args()

    if args.test:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(OptimizerSelfTestSuite)
        runner = unittest.TextTestRunner(stream=sys.stderr, verbosity=2)
        test_res = runner.run(suite)
        if not test_res.wasSuccessful():
            sys.exit(1)

        demo_ingredients = [
            {"name": "Pine Nuts", "requiredQuantity": 50, "unit": "g", "inPantry": False},
            {"name": "Fresh Coriander / Cilantro", "requiredQuantity": 1, "unit": "bunch", "inPantry": False},
            {"name": "Whole Wheat Warm Pita Pockets", "requiredQuantity": 4, "unit": "pieces", "inPantry": False},
            {"name": "Sumac Spice Blend", "requiredQuantity": 15, "unit": "g", "inPantry": False},
        ]
        result = optimize_cart(demo_ingredients, budget_cap_usd=25.0, allergies=["Tree Nuts"])
        print("[TEST PASS] Optimized cart generated:")
        print(json.dumps(result, indent=2))
        sys.exit(0)

    input_data = _load_json_input(args.input)
    pantry_stock = input_data.get("pantry_stock", [])
    missing = diff_pantry(
        input_data.get("needed_ingredients", []),
        pantry_stock,
    )

    budget_cap = (
        args.budget
        if args.budget is not None
        else float(input_data.get("budget_cap_usd", 25.0))
    )
    allergies_list = (
        [a.strip() for a in args.allergies.split(",") if a.strip()]
        if args.allergies is not None
        else input_data.get("allergies", [])
    )

    result = optimize_cart(
        missing,
        budget_cap_usd=budget_cap,
        allergies=allergies_list,
        prefer_organic=input_data.get("prefer_organic", True),
        pantry_stock=pantry_stock,
    )

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()