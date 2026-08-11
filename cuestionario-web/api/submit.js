/**
 * POST /api/submit — Cuestionario v2 (provider / homeowner)
 * Vercel Function · cero dependencias runtime · Notion API via fetch.
 *
 * - CORS restringido (producción + previews del proyecto + ALLOWED_ORIGINS env).
 * - Anti-spam sin cuentas nuevas: honeypot + tiempo mínimo + validación estricta.
 * - Gateado por env (fallback silencioso si no existen):
 *     KV_REST_API_URL + KV_REST_API_TOKEN  → rate limit, t0 de sesión, mapping session→page, stats.
 *     TURNSTILE_SECRET                     → verificación Cloudflare Turnstile (solo submit final).
 *     SUBMIT_HMAC_SECRET                   → firma HMAC de ts_start (tiempo mínimo confiable).
 * - Upsert por Session ID: parciales y final actualizan la MISMA página Notion.
 * - Resiliencia: si Notion rechaza propiedades, intento degradado + Overflow JSON.
 *   NUNCA se pierde la respuesta entera (peor caso: payload completo en logs + 200 queued).
 */

import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.NOTION_DATABASE_ID || '6d4735de-69f4-4d8b-b5ce-89bfcdb9f475';
const NOTION_VERSION = '2022-06-28';
const NOTION_BASE = 'https://api.notion.com/v1';

const KV_URL = process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';
const KV_ON = Boolean(KV_URL && KV_TOKEN);
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || '';
const HMAC_SECRET = process.env.SUBMIT_HMAC_SECRET || '';

const MIN_FILL_MS = 3000;              // final con menos de 3 s de llenado = bot
const MAX_FILL_MS = 7 * 24 * 3600e3;   // ts_start más viejo de 7 días = probable retoma por localStorage, NO bot
const MAX_BODY_BYTES = 100 * 1024;

/* ────────────────────────────── CORS ────────────────────────────── */

const STATIC_ORIGINS = ['https://investigacion.maclorianxgroup.com'];
const PREVIEW_RE = /^https:\/\/project-6lklw-[a-z0-9-]+(-migueljkrs-projects)?\.vercel\.app$/;
const LOCAL_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

export function originAllowed(origin) {
  if (!origin) return true; // same-origin / server-to-server: sin header Origin
  if (STATIC_ORIGINS.includes(origin)) return true;
  if (EXTRA_ORIGINS.includes(origin)) return true;
  if (PREVIEW_RE.test(origin)) return true;
  if (process.env.NODE_ENV !== 'production' && LOCAL_RE.test(origin)) return true;
  return false;
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (origin && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin); // NUNCA '*'
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  return !origin || originAllowed(origin);
}

/* ─────────────────────── ALLOWLISTS (contrato §1) ───────────────────────
 * SERVICE_SLUGS / COUNTY_NAMES / SLUG_GROUP: copias embebidas generadas desde
 * data/categorias.json y data/fl-geo.json; en cold start se intenta recargar
 * los JSON reales (fuente de verdad) — si el bundle no los trae, la copia manda.
 */

let SERVICE_SLUGS = [
  'plumbing', 'water-heaters', 'drain-sewer', 'septic', 'water-treatment', 'water-wells',
  'ac', 'heating', 'air-ducts', 'refrigeration',
  'electrician', 'lighting', 'generators', 'solar', 'ev-chargers',
  'house-cleaning', 'deep-cleaning', 'commercial-cleaning', 'carpet-upholstery', 'window-cleaning',
  'pressure-washing', 'gutter-cleaning', 'chimney',
  'general-pest', 'termites', 'mosquitoes', 'wildlife',
  'lawn-care', 'landscaping', 'tree-service', 'irrigation', 'fencing', 'concrete-paving',
  'decks-patios', 'dock-seawall', 'snow-removal',
  'pool-cleaning', 'pool-repair', 'pool-building', 'hot-tubs',
  'roofing', 'gutters-install', 'siding-stucco', 'windows-doors', 'garage-doors',
  'waterproofing-foundation', 'screens-hurricane',
  'painting', 'flooring', 'tile-stone', 'drywall', 'insulation', 'carpentry-cabinets',
  'countertops', 'home-organization',
  'general-contractor', 'kitchen-remodel', 'bathroom-remodel', 'additions-adu',
  'demolition-excavation', 'masonry',
  'handyman', 'appliance-repair', 'assembly-mounting', 'locksmith',
  'security-systems', 'home-automation', 'av-networking', 'fire-protection',
  'moving', 'packing', 'junk-removal',
  'water-damage', 'fire-smoke', 'mold', 'environmental',
  'home-inspection', 'energy-audit', 'home-watch', 'mobile-pet-care', 'property-management',
  'mobile-barber-beauty', 'mobile-auto-detailing', 'mobile-fitness-spa', 'other'
];

let SLUG_GROUP = {};
{
  const groups = {
    g1: ['plumbing', 'water-heaters', 'drain-sewer', 'septic', 'water-treatment', 'water-wells'],
    g2: ['ac', 'heating', 'air-ducts', 'refrigeration'],
    g3: ['electrician', 'lighting', 'generators', 'solar', 'ev-chargers'],
    g4: ['house-cleaning', 'deep-cleaning', 'commercial-cleaning', 'carpet-upholstery', 'window-cleaning', 'pressure-washing', 'gutter-cleaning', 'chimney'],
    g5: ['general-pest', 'termites', 'mosquitoes', 'wildlife'],
    g6: ['lawn-care', 'landscaping', 'tree-service', 'irrigation', 'fencing', 'concrete-paving', 'decks-patios', 'dock-seawall', 'snow-removal'],
    g7: ['pool-cleaning', 'pool-repair', 'pool-building', 'hot-tubs'],
    g8: ['roofing', 'gutters-install', 'siding-stucco', 'windows-doors', 'garage-doors', 'waterproofing-foundation', 'screens-hurricane'],
    g9: ['painting', 'flooring', 'tile-stone', 'drywall', 'insulation', 'carpentry-cabinets', 'countertops', 'home-organization'],
    g10: ['general-contractor', 'kitchen-remodel', 'bathroom-remodel', 'additions-adu', 'demolition-excavation', 'masonry'],
    g11: ['handyman', 'appliance-repair', 'assembly-mounting', 'locksmith'],
    g12: ['security-systems', 'home-automation', 'av-networking', 'fire-protection'],
    g13: ['moving', 'packing', 'junk-removal'],
    g14: ['water-damage', 'fire-smoke', 'mold', 'environmental'],
    g15: ['home-inspection', 'energy-audit', 'home-watch', 'mobile-pet-care', 'property-management', 'mobile-barber-beauty', 'mobile-auto-detailing', 'mobile-fitness-spa', 'other']
  };
  for (const [gid, slugs] of Object.entries(groups)) for (const s of slugs) SLUG_GROUP[s] = gid;
}

let COUNTY_NAMES = [
  'Alachua', 'Baker', 'Bay', 'Bradford', 'Brevard', 'Broward', 'Calhoun', 'Charlotte', 'Citrus',
  'Clay', 'Collier', 'Columbia', 'DeSoto', 'Dixie', 'Duval', 'Escambia', 'Flagler', 'Franklin',
  'Gadsden', 'Gilchrist', 'Glades', 'Gulf', 'Hamilton', 'Hardee', 'Hendry', 'Hernando',
  'Highlands', 'Hillsborough', 'Holmes', 'Indian River', 'Jackson', 'Jefferson', 'Lafayette',
  'Lake', 'Lee', 'Leon', 'Levy', 'Liberty', 'Madison', 'Manatee', 'Marion', 'Martin',
  'Miami-Dade', 'Monroe', 'Nassau', 'Okaloosa', 'Okeechobee', 'Orange', 'Osceola', 'Palm Beach',
  'Pasco', 'Pinellas', 'Polk', 'Putnam', 'Santa Rosa', 'Sarasota', 'Seminole', 'St. Johns',
  'St. Lucie', 'Sumter', 'Suwannee', 'Taylor', 'Union', 'Volusia', 'Wakulla', 'Walton', 'Washington'
];

// Recarga desde los JSON reales si el bundle los incluye (fuente de verdad única).
try {
  const req = createRequire(import.meta.url);
  const cat = req('../data/categorias.json');
  const slugs = (cat.grupos || []).flatMap(g => (g.categorias || []).map(c => c.slug)).filter(Boolean);
  if (slugs.length >= 60) {
    if (!slugs.includes('other')) slugs.push('other');
    SERVICE_SLUGS = slugs;
    const map = {};
    for (const g of cat.grupos) for (const c of (g.categorias || [])) map[c.slug] = g.id;
    map.other = map.other || 'g15';
    SLUG_GROUP = map;
  }
  const geo = req('../data/fl-geo.json');
  if (Array.isArray(geo.counties) && geo.counties.length === 67) COUNTY_NAMES = geo.counties;
} catch { /* fallback silencioso a las copias embebidas */ }

const LEGACY_ICP_SLUGS = ['mobile-barber-beauty', 'mobile-auto-detailing', 'mobile-fitness-spa'];

const GRID_ROWS = ['pest', 'lawn', 'pool', 'ac_plan', 'cleaning', 'home_watch', 'warranty', 'membership', 'other'];
const GRID_RANGES = ['lt25', '25_50', '51_100', '101_200', '200_plus'];
const GRID_MIDPOINTS = { lt25: 12, '25_50': 38, '51_100': 75, '101_200': 150, '200_plus': 250 };

/* Especificación de campos: t = slug|multi|str|int|num|bool  ·  a = allowlist  ·  m = max len */
const FIELD_SPEC = {
  // ── meta / contacto / geo ──
  name:        { t: 'str', m: 100 },
  email:       { t: 'str', m: 100 },
  phone:       { t: 'str', m: 30 },
  sms_consent: { t: 'bool' },
  lang_pref:   { t: 'slug', a: ['es', 'en', 'either'] },
  zip:         { t: 'str', m: 5 },
  city:        { t: 'str', m: 60 },
  county:      { t: 'slug', a: COUNTY_NAMES },
  county_fips: { t: 'str', m: 5 },
  state:       { t: 'str', m: 2 },
  country:     { t: 'str', m: 2 },
  ref:         { t: 'str', m: 60 },
  // 'form' (client|provider) se descarta a propósito: no persiste en Notion y el origen del deep-link
  // ya queda registrado vía 'ref' (Fuente) y 'type' (Tipo). Se omite de FIELD_SPEC para que no haya
  // validación silenciosa de un dato que nunca se guarda. Si algún día se quiere conservar, añadir
  // 'form' aquí Y una entrada en PROP_MAP con una propiedad Notion existente.
  utm:         { t: 'str', m: 300 },
  vertical:    { t: 'slug', a: ['home', 'beauty', 'pets', 'food', 'fitness', 'auto', 'gifts', 'other'] },

  // ── proveedor ──
  p_screener:          { t: 'slug', a: ['main', 'part_time', 'employee', 'none'] },
  p_business:          { t: 'str', m: 100 },
  p_crew:              { t: 'slug', a: ['solo', '1_2', '3_5', '6_15', '15_plus'] },
  p_years:             { t: 'slug', a: ['lt2', '2_5', '5_10', '10_plus'] },
  p_service_area:      { t: 'slug', a: ['city', 'county', 'multi_county', 'anywhere'] },
  p_counties:          { t: 'multi', a: COUNTY_NAMES, fips3: true },
  p_services:          { t: 'multi', a: SERVICE_SLUGS },
  p_services_other:    { t: 'str', m: 200 },
  p_main:              { t: 'slug', a: SERVICE_SLUGS },
  p_customers_12m:     { t: 'slug', a: ['1_25', '26_50', '51_100', '101_250', '250_plus'] },
  p_repeat_pct:        { t: 'slug', a: ['lt25', '25_50', '50_75', 'gt75'] },
  p_plan_today:        { t: 'slug', a: ['formal', 'informal', 'tried', 'never'] },
  p_plan_count:        { t: 'int', min: 0, max: 9999 },
  p_plan_price:        { t: 'slug', a: ['lt20', '20_50', '51_100', '101_175', '176_300', 'gt300'] },
  p_plan_quit_why:     { t: 'slug', a: ['no_commit', 'collect_mess', 'still_late', 'pricing', 'other'] },
  p_plan_quit_why_other: { t: 'str', m: 300 },
  p_billing:           { t: 'multi', a: ['cash_check', 'zelle_venmo', 'quickbooks', 'fsm', 'stripe_square', 'other'] },
  p_billing_other:     { t: 'str', m: 200 },
  p_recurring_3m:      { t: 'slug', a: ['0', '1_10', '11_50', '50_plus'] },
  p_revenue_band:      { t: 'slug', a: ['lt5k', '5_10k', '10_25k', '25k_plus', 'prefer_not'] },
  p_software:          { t: 'multi', a: ['paper', 'sheets', 'quickbooks', 'jobber', 'hcp', 'servicetitan', 'other_fsm', 'other', 'nothing'] },
  p_software_other:    { t: 'str', m: 200 },
  p_software_spend:    { t: 'slug', a: ['0', '1_50', '51_150', '151_300', '300_plus'] },
  p_software_pain:     { t: 'str', m: 2000 },
  p_marketplace_spend: { t: 'slug', a: ['0', 'lt100', '100_300', '301_500', '501_1000', 'gt1000'] },
  p_lead_conversion:   { t: 'slug', a: ['0_1', '2_3', '4_5', '6_plus', 'no_track'] },
  p_last_customer:     { t: 'slug', a: ['referral', 'google', 'fb_nextdoor', 'marketplace', 'truck_sign', 'other'] },
  p_last_customer_other: { t: 'str', m: 200 },
  p_pain_top:          { t: 'slug', a: ['no_pay', 'noshows', 'fake_leads', 'slow_season', 'chasing', 'crew', 'other'] },
  p_pain_top_other:    { t: 'str', m: 300 },
  p_noshows:           { t: 'slug', a: ['none', '1_2', '3_5', 'gt5'] },
  p_deposit:           { t: 'slug', a: ['no', 'sometimes', 'always_50', 'full'] },
  p_seasonal_pct:      { t: 'slug', a: ['almost_none', 'lt25', '25_50', 'gt50', 'unsure'] },
  p_seasonality:       { t: 'slug', a: ['hard', 'some', 'stable'] },
  p_pain_story:        { t: 'str', m: 2000 },
  p_reaction:          { t: 'slug', a: ['want_now', 'doubts', 'meh', 'already'] },
  p_reaction_why:      { t: 'str', m: 2000 },
  p_model_pref:        { t: 'slug', a: ['per_lead', 'commission', 'flat_fee', 'none'] },
  p_model_pref_why:    { t: 'str', m: 500 },
  p_fee_10:            { t: 'slug', a: ['fair', 'cheap', 'too_much', 'depends'] },
  p_fee_10_incl:       { t: 'str', m: 500 },
  p_bundle_price:      { t: 'slug', a: ['lt60', '60_130', '130_250', '250_400', '400_plus', 'calc'] },
  p_vw_expensive:      { t: 'num', min: 0, max: 9999 },
  p_vw_bargain:        { t: 'num', min: 0, max: 9999 },
  p_blockers:          { t: 'multi', a: ['clients_no', 'trust', 'fee', 'works', 'paperwork', 'nothing', 'other'] },
  p_blockers_other:    { t: 'str', m: 300 },
  p_commitment:        { t: 'multi', a: ['send_10', 'call_15', 'sign_pilot', 'nothing'] },

  // ── módulos verticales (proveedor) ──
  p_bb_service_price:  { t: 'num', min: 0, max: 9999 },
  p_bb_visit_freq:     { t: 'slug', a: ['weekly', 'biweekly', 'monthly', '6_8wk', 'quarterly', 'irregular'] },
  p_bb_capacity:       { t: 'slug', a: ['almost_full', 'lt25', '25_50', 'gt50'] },
  p_bb_slow_when:      { t: 'multi', a: ['mon_thu', 'mornings', 'midday', 'seasonal', 'no_pattern'] },
  p_bb_regulars:       { t: 'int', min: 0, max: 99999 },
  p_bb_walkins:        { t: 'slug', a: ['mostly_appt', 'half_half', 'mostly_walkin', 'all_walkin'] },
  p_bb_structure:      { t: 'slug', a: ['n_services', 'unlimited', 'pct_off', 'credits', 'unsure'] },
  p_bb_addons:         { t: 'multi', a: ['beard', 'wash_scalp', 'color_treat', 'facial_mask', 'nail_art', 'brow_lash', 'none', 'other'] },
  p_bb_addons_other:   { t: 'str', m: 200 },
  p_bb_credits:        { t: 'slug', a: ['rolls_over', 'expires', 'refund', 'no_prepay', 'never_happened'] },
  p_pet_subtype:         { t: 'slug', a: ['grooming', 'daycare', 'walking', 'boarding', 'training', 'other'] },
  p_pet_subtype_other:   { t: 'str', m: 200 },
  p_pet_freq_groom:      { t: 'slug', a: ['lt1_mo', 'once_mo', 'twice_mo', '3plus_mo'] },
  p_pet_freq_daycare:    { t: 'slug', a: ['1_2_wk', '3_4_wk', '5_wk', 'occasional'] },
  p_pet_freq_walk:       { t: 'slug', a: ['1_2_wk', '3_wk', '5_wk', '5plus_wk'] },
  p_pet_freq_board:      { t: 'slug', a: ['1_2_yr', 'quarterly', 'monthly', 'weekly'] },
  p_pet_price_varies:    { t: 'bool' },
  p_pet_price_small:     { t: 'num', min: 0, max: 9999 },
  p_pet_price_large:     { t: 'num', min: 0, max: 9999 },
  p_pet_matting:         { t: 'slug', a: ['charge_extra', 'absorb', 'refuse', 'rare'] },
  p_pet_capacity:        { t: 'slug', a: ['full', 'few', 'quarter', 'half_plus'] },
  p_pet_structure:       { t: 'slug', a: ['n_visits', 'unlimited', 'discount_only', 'prepaid_pack', 'unsure'] },
  p_pet_unlimited_cap:   { t: 'slug', a: ['1_2', '3_4', '5_plus', 'no_cap'] },
  p_pet_extras_discount: { t: 'slug', a: ['yes_set', 'yes_informal', 'no', 'no_extras'] },
  p_pet_extras_pct:      { t: 'int', min: 0, max: 100 },
  p_pet_multi_pet:       { t: 'slug', a: ['yes_discount', 'same_price', 'rare_multi'] },
  p_pet_prepaid_tried:   { t: 'slug', a: ['yes_works', 'yes_stopped', 'never'] },
  p_pet_prepaid_story:   { t: 'str', m: 2000 },
  p_pet_requirements:    { t: 'multi', a: ['vaccines', 'temperament', 'spay_neuter', 'flea', 'trial', 'nothing', 'other'] },
  p_pet_requirements_other: { t: 'str', m: 200 },
  p_pet_founder_lock:    { t: 'slug', a: ['yes', 'depends', 'no'] },
  p_food_optype:         { t: 'slug', a: ['restaurant', 'cafe', 'mealprep', 'foodtruck', 'cottage', 'homekitchen'] },
  p_food_commissary:     { t: 'slug', a: ['own_kitchen', 'shared_commissary', 'none_yet'] },
  p_food_fulfillment:    { t: 'multi', a: ['delivery', 'pickup', 'dropoff_points', 'dine_in'] },
  p_food_delivery_radius:{ t: 'slug', a: ['lt3mi', '3_7mi', '7_15mi', 'gt15mi'] },
  p_food_capacity:       { t: 'int', min: 0, max: 9999 },
  p_food_menu:           { t: 'slug', a: ['fixed', 'weekly_rotating', 'daily_special', 'seasonal'] },
  p_food_prepaid:        { t: 'slug', a: ['prepaid', 'mixed', 'fiado', 'no_subs'] },
  p_fit_subtype:         { t: 'slug', a: ['gym_boutique', 'trainer', 'yoga_pilates', 'martial_arts', 'dance', 'swim', 'other'] },
  p_fit_subtype_other:   { t: 'str', m: 200 },
  p_fit_capacity:        { t: 'slug', a: ['solo_1a1', 'lte6', '7_15', '16_30', 'gt30'] },
  p_fit_peak:            { t: 'multi', a: ['early_am', 'midday', 'evening', 'weekend', 'never_full'] },
  p_fit_churn:           { t: 'slug', a: ['lt5', '5_10', '10_20', 'gt20', 'no_track'] },
  p_fit_structure:       { t: 'slug', a: ['unlimited', 'n_classes', 'prepaid_pack', 'dropin', 'unsure'] },
  p_fit_month_price:     { t: 'slug', a: ['lt60', '60_120', '120_200', '200_360', 'gt360'] },
  p_fit_contract:        { t: 'slug', a: ['monthly', 'short', 'annual', 'long', 'none_dropin'] },
  p_fit_prepay_long:     { t: 'slug', a: ['no', 'prepay', 'contract', 'both'] },
  p_staffing:          { t: 'slug', a: ['solo', 'employees', 'commission', 'booth_rent', 'mixed'] },
  p_tips_prepaid:      { t: 'slug', a: ['per_visit', 'in_plan', 'none', 'unsure'] },

  // ── homeowner ──
  h_screener:          { t: 'slug', a: ['year_round', 'snowbird', 'rental', 'renter'] },
  h_property:          { t: 'slug', a: ['single_family', 'villa_town', 'condo', 'mobile', 'other'] },
  h_pool:              { t: 'bool' },
  h_lanai:             { t: 'bool' },
  h_homewatch:         { t: 'slug', a: ['paid', 'neighbor', 'nobody'] },
  h_household:         { t: 'slug', a: ['family_kids', 'working', 'retired', 'snowbird_id', 'other'] },
  h_years_fl:          { t: 'slug', a: ['lt2', '2_5', '5_15', '15_plus'] },
  h_services:          { t: 'multi', a: SERVICE_SLUGS },
  h_services_other:    { t: 'str', m: 200 },
  h_recurring_grid:    { t: 'grid' },
  h_annual_prepay:     { t: 'slug', a: ['yes_discount', 'yes', 'no', 'none'] },
  h_spend_annual:      { t: 'slug', a: ['lt500', '500_1000', '1001_2500', '2501_5000', 'gt5000', 'unsure'] },
  h_goto:              { t: 'slug', a: ['one_all', 'per_trade', 'scratch'] },
  h_discovery:         { t: 'slug', a: ['referral', 'whatsapp', 'facebook', 'nextdoor', 'google', 'marketplace', 'truck_sign', 'other'] },
  h_discovery_other:   { t: 'str', m: 200 },
  h_payment:           { t: 'multi', a: ['cash', 'check', 'zelle', 'venmo', 'paypal', 'card', 'transfer', 'other'] },
  h_payment_other:     { t: 'str', m: 200 },
  h_emergency_when:    { t: 'slug', a: ['this_year', '1_3y', 'never'] },
  h_emergency_exp:     { t: 'slug', a: ['regular_fast', 'called_around', 'waited', 'diy'] },
  h_emergency_story:   { t: 'str', m: 2000 },
  h_hurricane:         { t: 'slug', a: ['diy_none', 'lt200', '200_500', '501_1000', 'gt1000'] },
  h_hurricane_who:     { t: 'str', m: 500 },
  h_pain_top:          { t: 'slug', a: ['reliable', 'noshow', 'surprise_price', 'no_answer', 'quality', 'juggling', 'other'] },
  h_pain_top_other:    { t: 'str', m: 300 },
  h_pain_story:        { t: 'str', m: 2000 },
  h_reaction:          { t: 'slug', a: ['sign_me', 'if_price', 'per_visit', 'no_subs'] },
  h_reaction_why:      { t: 'str', m: 2000 },
  h_vw_too_expensive:  { t: 'num', min: 0, max: 9999 },
  h_vw_expensive:      { t: 'num', min: 0, max: 9999 },
  h_vw_bargain:        { t: 'num', min: 0, max: 9999 },
  h_vw_too_cheap:      { t: 'num', min: 0, max: 9999 },
  h_intent:            { t: 'slug', a: ['definitely', 'probably', 'maybe', 'no'] },
  h_expectations:      { t: 'multi', a: ['priority', 'locked_price', 'same_tech', 'pause', 'discount', 'writing_cancel', 'other'] },
  h_expectations_other: { t: 'str', m: 300 },
  h_priority_access:   { t: 'slug', a: ['yes', 'no'] },
  h_anything:          { t: 'str', m: 2000 }
};

/* ──────────────────────── sanitización / validación ──────────────────────── */

const RX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RX_ZIP = /^\d{5}$/;
const RX_FIPS = /^12\d{3}$/;
const RX_FIPS3 = /^\d{3}$/;
const RX_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const RX_STATE = /^[A-Za-z]{2}$/;
const RX_REF = /^[\w.\-]{1,60}$/;
// eslint-disable-next-line no-control-regex
const RX_CTRL = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", 'g');

function cleanStr(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.replace(RX_CTRL, '').trim().slice(0, max);
  return s.length ? s : null;
}

function sanitizeField(key, raw) {
  const spec = FIELD_SPEC[key];
  if (!spec || raw === undefined || raw === null || raw === '') return undefined;
  switch (spec.t) {
    case 'slug': {
      const s = cleanStr(raw, 80);
      return s && spec.a.includes(s) ? s : undefined;
    }
    case 'multi': {
      if (!Array.isArray(raw)) return undefined;
      const out = [];
      for (const item of raw.slice(0, 100)) {
        const s = cleanStr(item, 80);
        if (!s) continue;
        if (spec.a.includes(s)) out.push(s);
        else if (spec.fips3 && RX_FIPS3.test(s)) out.push(s); // fips3 crudo tolerado
      }
      return out.length ? [...new Set(out)] : undefined;
    }
    case 'str':
      return cleanStr(raw, spec.m) || undefined;
    case 'int': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return undefined;
      return Math.max(spec.min, Math.min(spec.max, Math.round(n)));
    }
    case 'num': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return undefined;
      return Math.max(spec.min, Math.min(spec.max, Math.round(n * 100) / 100));
    }
    case 'bool':
      return raw === true || raw === 'true' || raw === 1 ? true
        : (raw === false || raw === 'false' || raw === 0 ? false : undefined);
    case 'grid': {
      if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
      const rowsIn = (raw.rows && typeof raw.rows === 'object' && !Array.isArray(raw.rows)) ? raw.rows : {};
      const rows = {};
      for (const [rk, rv] of Object.entries(rowsIn)) {
        if (GRID_ROWS.includes(rk) && GRID_RANGES.includes(rv)) rows[rk] = rv;
      }
      const other = cleanStr(raw.other_text, 200);
      const out = { rows };
      if (other) out.other_text = other;
      return out; // {} de filas = "ninguno", válido
    }
    default:
      return undefined;
  }
}

/**
 * Valida y sanitiza el payload completo. Devuelve { ok, error?, data? }.
 * Campos desconocidos se ignoran (forward-compat). Valores inválidos se descartan.
 */
export function validatePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'validation' };
  }

  let type = body.type;
  if (type === 'client' || type === 'cliente') type = 'homeowner'; // alias legacy
  if (type === 'proveedor') type = 'provider';
  if (type !== 'provider' && type !== 'homeowner') return { ok: false, error: 'validation' };

  const sid = typeof body.session_id === 'string' ? body.session_id.trim() : '';
  if (!RX_UUID.test(sid)) return { ok: false, error: 'validation' };

  const partial = body.partial !== false; // solo false explícito = final
  let step = Number(body.step);
  if (!Number.isFinite(step)) step = 1;
  step = Math.max(1, Math.min(12, Math.round(step)));

  const data = {
    type,
    partial,
    step,
    session_id: sid,
    lang: body.lang === 'en' ? 'en' : 'es'
  };

  const pageId = cleanStr(body.page_id, 40);
  if (pageId && /^[0-9a-f-]{32,36}$/i.test(pageId)) data.page_id = pageId;

  const tsStart = Number(body.ts_start);
  if (Number.isFinite(tsStart) && tsStart > 0) data.ts_start = Math.round(tsStart);
  const tsSig = cleanStr(body.ts_sig, 128);
  if (tsSig && /^[0-9a-f]+$/i.test(tsSig)) data.ts_sig = tsSig;

  const dur = Number(body.duration_s);
  if (Number.isFinite(dur) && dur >= 0) data.duration_s = Math.min(999999, Math.round(dur));

  const tt = cleanStr(body.turnstile_token, 2048);
  if (tt) data.turnstile_token = tt;

  // meta con reglas propias
  const prefix = type === 'provider' ? 'p_' : 'h_';
  for (const key of Object.keys(FIELD_SPEC)) {
    // solo campos del rol activo + meta compartida
    if ((key.startsWith('p_') || key.startsWith('h_')) && !key.startsWith(prefix)) continue;
    const v = sanitizeField(key, body[key]);
    if (v !== undefined) data[key] = v;
  }

  // clears (§fix #5): ids de respuestas retractadas (ramas condicionales abandonadas).
  // Solo se honran en el FINAL y solo para campos del rol activo que NO llegaron respondidos
  // (nunca pisan una respuesta presente). El server los borra en Notion; un parcial nunca borra.
  if (!partial && Array.isArray(body.clears)) {
    const clears = [];
    for (const id of body.clears.slice(0, 200)) {
      if (typeof id !== 'string') continue;
      const k = id.trim();
      if (!k.startsWith(prefix)) continue;
      if (!Object.prototype.hasOwnProperty.call(FIELD_SPEC, k)) continue;
      if (data[k] !== undefined) continue;
      clears.push(k);
    }
    if (clears.length) data.clears = [...new Set(clears)];
  }

  // refinamientos
  if (data.zip && !RX_ZIP.test(data.zip)) delete data.zip;
  if (data.email && !RX_EMAIL.test(data.email)) delete data.email;
  if (data.county_fips && !RX_FIPS.test(data.county_fips)) delete data.county_fips;
  if (data.state) data.state = RX_STATE.test(data.state) ? data.state.toUpperCase() : undefined;
  if (!data.state) data.state = 'FL';
  if (data.country) data.country = RX_STATE.test(data.country) ? data.country.toUpperCase() : undefined;
  if (!data.country) data.country = 'US';
  if (data.ref && !RX_REF.test(data.ref)) delete data.ref;
  if (data.phone && !/^[\d\s()+.\-ext]{7,30}$/i.test(data.phone)) delete data.phone;
  // p_main debe pertenecer a p_services si ambos vienen
  if (data.p_main && Array.isArray(data.p_services) && data.p_services.length && !data.p_services.includes(data.p_main)) {
    delete data.p_main;
  }
  // sms_consent solo tiene sentido con teléfono
  if (data.sms_consent && !data.phone) delete data.sms_consent;

  // final sin ninguna respuesta de rol = payload sin sentido
  if (!partial) {
    const hasAnswers = Object.keys(data).some(k => k.startsWith(prefix));
    if (!hasAnswers) return { ok: false, error: 'validation' };
  }

  return { ok: true, data };
}

/* ─────────────────────────── KV (Upstash REST, gateado) ─────────────────────────── */

async function kv(...cmd) {
  if (!KV_ON) return null;
  try {
    const r = await fetch(KV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd.map(String)),
      signal: AbortSignal.timeout(2500)
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j && Object.prototype.hasOwnProperty.call(j, 'result') ? j.result : null;
  } catch {
    return null; // KV caído → seguir sin romper
  }
}

/* ───────────────────────────── rate limit ─────────────────────────────
 * Best-effort en memoria (sobrevive mientras la lambda esté caliente) +
 * ventana fija en KV si está configurado.
 */

const memRl = new Map(); // key -> { n, reset }
function memRateLimit(key, limit, windowMs) {
  const now = Date.now();
  if (memRl.size > 5000) {
    for (const [k, v] of memRl) if (v.reset < now) memRl.delete(k);
  }
  const cur = memRl.get(key);
  if (!cur || cur.reset < now) {
    memRl.set(key, { n: 1, reset: now + windowMs });
    return true;
  }
  cur.n += 1;
  return cur.n <= limit;
}

async function rateLimited(ip, isFinal) {
  const limit = isFinal ? 5 : 30;
  const windowS = 600;
  const scope = isFinal ? 'f' : 'p';
  if (!memRateLimit(`${scope}:${ip}`, limit, windowS * 1000)) return true;
  if (KV_ON) {
    const bucket = Math.floor(Date.now() / (windowS * 1000));
    const key = `rl:${scope}:${ip}:${bucket}`;
    const n = await kv('INCR', key);
    if (n === 1) await kv('EXPIRE', key, windowS);
    if (typeof n === 'number' && n > limit) return true;
  }
  return false;
}

/* ──────────────────────── tiempo mínimo / HMAC / Turnstile ──────────────────────── */

function hmacOk(tsStart, sig) {
  if (!HMAC_SECRET || !tsStart || !sig) return false;
  try {
    const expected = crypto.createHmac('sha256', HMAC_SECRET).update(String(tsStart)).digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(sig, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * true = parece bot (llenado demasiado rápido) → responder 200 fake.
 * Sesgo intencional a NO descartar: solo el "demasiado rápido" (elapsed ∈ [0, MIN_FILL_MS)) cuenta como bot.
 * Un elapsed negativo (reloj adelantado) o muy grande (retoma por localStorage días después) NO es bot.
 * La firma HMAC solo se exige cuando el cliente REALMENTE la manda; su ausencia nunca descarta un final real.
 */
export async function failsMinTime(data) {
  if (data.partial) return false; // solo se exige en el final
  const now = Date.now();

  // 1) Fuente de verdad preferida: t0 server-side en KV (no manipulable por el cliente).
  if (KV_ON) {
    const t0 = Number(await kv('GET', `sess:${data.session_id}:t0`));
    if (Number.isFinite(t0) && t0 > 0) {
      const elapsed = now - t0;
      return elapsed >= 0 && elapsed < MIN_FILL_MS; // solo el llenado ultra-rápido = bot
    }
  }

  // 2) HMAC: SOLO si el cliente firmó (evidencia real). Una firma presente pero inválida = manipulación.
  //    Sin firma NO se trata como bot: el HTML estático puede no firmar aunque exista SUBMIT_HMAC_SECRET.
  if (HMAC_SECRET && data.ts_start && data.ts_sig) {
    if (!hmacOk(data.ts_start, data.ts_sig)) return true;
    const elapsed = now - data.ts_start;
    if (elapsed < 0) return false;              // reloj adelantado → no bot
    if (elapsed > MAX_FILL_MS) return false;    // retomó días después → no bot
    return elapsed < MIN_FILL_MS;
  }

  // 3) Fallback best-effort: min-time por ts_start del cliente (sin firma).
  if (data.ts_start) {
    const elapsed = now - data.ts_start;
    if (elapsed >= 0 && elapsed < MIN_FILL_MS) return true;
  }
  return false;
}

async function turnstileOk(data, ip) {
  if (!TURNSTILE_SECRET) return true;      // gate apagado → skip silencioso
  if (data.partial) return true;           // solo submit final
  if (!data.turnstile_token) {
    // secret activo pero el cliente no mandó token (site key no montada / desalineada).
    // NO romper un final real por una desconfiguración: fail-open y loguear (§fix #4).
    console.warn('[submit] Turnstile activo sin token del cliente — fail-open; revisar TURNSTILE_SITE_KEY en el HTML');
    return true;
  }
  try {
    const params = new URLSearchParams({ secret: TURNSTILE_SECRET, response: data.turnstile_token });
    if (ip) params.set('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(5000)
    });
    const j = await r.json();
    return j && j.success === true;
  } catch (err) {
    console.error('[submit] turnstile verify error (fail-open):', err && err.message);
    return true; // Cloudflare caído no debe perder respuestas reales
  }
}

/* ─────────────────────────── inferencias (§2.5, bilingües) ─────────────────────────── */

const PAIN_KW = {
  es: ['terrible', 'horrible', 'arruina', 'pesadilla', 'desastre'],
  en: ['nightmare', 'awful', 'killing me', 'horrible', 'disaster']
};

function painKeywordBoost(data) {
  const texts = data.type === 'provider'
    ? [data.p_pain_story, data.p_software_pain, data.p_reaction_why]
    : [data.h_emergency_story, data.h_pain_story, data.h_reaction_why];
  const blob = texts.filter(Boolean).join(' ').toLowerCase();
  if (!blob) return 0;
  const kws = PAIN_KW[data.lang] || PAIN_KW.es;
  const all = [...kws, ...(data.lang === 'en' ? PAIN_KW.es : PAIN_KW.en)]; // bilingüe: mira ambas
  return all.some(k => blob.includes(k)) ? 1 : 0;
}

function computeDolor(data) {
  let score;
  if (data.type === 'provider') {
    if (!data.p_pain_top) return null;
    score = 6;
    if (data.p_noshows === '3_5' || data.p_noshows === 'gt5') score += 1;
    if (data.p_lead_conversion === '0_1') score += 1;
    if (data.p_seasonality === 'hard') score += 1;
  } else {
    if (!data.h_pain_top && !data.h_emergency_exp) return null;
    score = 5;
    if (data.h_emergency_exp === 'waited') score += 2;
    if (data.h_pain_top === 'noshow' || data.h_pain_top === 'reliable') score += 1;
    if (data.h_goto === 'scratch') score += 1;
  }
  score += painKeywordBoost(data);
  return Math.max(1, Math.min(10, score));
}

function computeReceptividad(data) {
  let score;
  if (data.type === 'provider') {
    const base = { want_now: 8, doubts: 6, already: 5, meh: 2 };
    if (!data.p_reaction) return null;
    score = base[data.p_reaction];
    if (data.p_fee_10 === 'fair') score += 1;
    const c = data.p_commitment || [];
    if (c.includes('sign_pilot') || c.includes('send_10')) score += 1;
    else if (c.includes('call_15')) score += 0.5;
  } else {
    const base = { sign_me: 8, if_price: 6, per_visit: 3, no_subs: 2 };
    if (!data.h_reaction) return null;
    score = base[data.h_reaction];
    if (data.h_intent === 'definitely') score += 1; // intención declarada, descontada
    if (data.h_priority_access === 'yes') score += 1;
  }
  return Math.max(1, Math.min(10, Math.round(score)));
}

function computeBundles(data) {
  if (data.type === 'provider') {
    const priceOk = Boolean(data.p_bundle_price && data.p_bundle_price !== 'calc');
    const groups = new Set((data.p_services || []).map(s => SLUG_GROUP[s]).filter(Boolean));
    const multiGroup = groups.size >= 2;
    if (!data.p_bundle_price && !(data.p_services || []).length) return 'No aplica';
    if (priceOk && multiGroup) return 'Alta';
    if (priceOk || multiGroup) return 'Media';
    return 'Baja';
  }
  const rows = data.h_recurring_grid ? Object.keys(data.h_recurring_grid.rows || {}) : null;
  if (rows === null && !data.h_reaction) return 'No aplica';
  const n = rows ? rows.length : 0;
  if (n >= 3 && (data.h_reaction === 'sign_me' || data.h_reaction === 'if_price')) return 'Alta';
  if (n >= 1) return 'Media';
  if (n === 0 && (data.h_reaction === 'per_visit' || data.h_reaction === 'no_subs')) return 'Baja';
  return 'Media';
}

function computeHurricane(data) {
  if (data.type !== 'homeowner' || !data.h_hurricane) return null;
  if (data.h_hurricane === '501_1000' || data.h_hurricane === 'gt1000') return 'Alto';
  if (data.h_hurricane === '200_500') return 'Medio';
  return 'Bajo'; // lt200 · diy_none
}

function computeProximoPaso(data) {
  if (data.type === 'provider') {
    const c = data.p_commitment || [];
    const active = c.filter(x => x !== 'nothing');
    return active.length ? 'nurture' : 'sin-accion';
  }
  const hasContact = Boolean(data.email || data.phone);
  return (data.h_priority_access === 'yes' && hasContact) ? 'lista-piloto-zip' : 'sin-accion';
}

function computeFrase(data) {
  const order = data.type === 'provider'
    ? [data.p_pain_story, data.p_reaction_why, data.p_software_pain]
    : [data.h_emergency_story, data.h_reaction_why, data.h_pain_story];
  const first = order.find(t => t && t.trim().length > 0);
  return first ? first.trim().slice(0, 200) : '';
}

function computeFueraIcp(data) {
  if (data.type !== 'provider') return false;
  const services = (data.p_services || []).filter(s => s !== 'other');
  const allLegacy = services.length > 0 && services.every(s => LEGACY_ICP_SLUGS.includes(s));
  const partTimeNoRecurring = data.p_screener === 'part_time' && data.p_recurring_3m === '0';
  return allLegacy || partTimeNoRecurring;
}

function gridSum(grid) {
  if (!grid || !grid.rows) return null;
  const vals = Object.values(grid.rows);
  if (!vals.length) return 0;
  return vals.reduce((acc, r) => acc + (GRID_MIDPOINTS[r] || 0), 0);
}

function buildNotas(data) {
  const L = [];
  L.push(`Rol: ${data.type} | Paso: ${data.step}${data.partial ? ' (parcial)' : ' (final)'} | Idioma: ${data.lang}`);
  if (data.ref) L.push(`Referido por: ${data.ref}`);
  const geo = [data.zip, data.city, data.county, data.state].filter(Boolean).join(', ');
  if (geo) L.push(`Zona: ${geo}`);
  if (data.type === 'provider') {
    if (data.p_screener) L.push(`Screener: ${data.p_screener}`);
    if (data.p_business) L.push(`Negocio: ${data.p_business}`);
    if (data.p_services) L.push(`Servicios (${data.p_services.length}): ${data.p_services.join(', ')}`);
    if (data.p_main) L.push(`Principal: ${data.p_main}`);
    if (data.p_pain_top) L.push(`Dolor #1: ${data.p_pain_top}${data.p_pain_top_other ? ` (${data.p_pain_top_other})` : ''}`);
    if (data.p_reaction) L.push(`Reacción: ${data.p_reaction}`);
    if (data.p_model_pref) L.push(`Modelo pref: ${data.p_model_pref} | 10%: ${data.p_fee_10 || '-'}`);
    if (data.p_bundle_price) L.push(`Bundle: ${data.p_bundle_price}`);
    if (data.p_commitment) L.push(`Compromiso: ${data.p_commitment.join(', ')}`);
  } else {
    if (data.h_screener) L.push(`Screener: ${data.h_screener}`);
    if (data.h_services) L.push(`Servicios 12m (${data.h_services.length}): ${data.h_services.join(', ')}`);
    if (data.h_recurring_grid) {
      const rows = Object.entries(data.h_recurring_grid.rows || {});
      L.push(`Recurrentes hoy: ${rows.length ? rows.map(([k, v]) => `${k}=${v}`).join(', ') : 'ninguno'}`);
    }
    if (data.h_pain_top) L.push(`Frustración #1: ${data.h_pain_top}${data.h_pain_top_other ? ` (${data.h_pain_top_other})` : ''}`);
    if (data.h_reaction) L.push(`Reacción: ${data.h_reaction}`);
    if (data.h_intent) L.push(`Intención: ${data.h_intent} | Acceso prioritario: ${data.h_priority_access || '-'}`);
  }
  if (data.duration_s !== undefined) L.push(`Duración: ${data.duration_s}s`);
  return L.join('\n').slice(0, 1990);
}

/* ─────────────────────────── mapping Notion ─────────────────────────── */

function rtChunks(s, chunk = 1900) {
  const str = String(s);
  const out = [];
  for (let i = 0; i < str.length && out.length < 90; i += chunk) {
    out.push({ text: { content: str.slice(i, i + chunk) } });
  }
  return out.length ? out : [{ text: { content: '' } }];
}
const RT = s => ({ rich_text: rtChunks(s) });
const SEL = s => ({ select: { name: String(s).slice(0, 100) } });
const MULTI = arr => ({ multi_select: arr.map(v => ({ name: String(v).slice(0, 100) })) });
const NUM = n => ({ number: n });
const CHK = b => ({ checkbox: Boolean(b) });
// Tipo Notion de cada builder → usado por scripts/setup-notion-schema.mjs (fuente única).
RT.nt = 'rich_text'; SEL.nt = 'select'; MULTI.nt = 'multi_select'; NUM.nt = 'number'; CHK.nt = 'checkbox';

// Valor "vacío" por tipo Notion — usado por los clears del submit FINAL (§fix #5) para borrar
// respuestas retractadas sin dejar restos de ramas abandonadas.
const EMPTY_BY_NT = {
  rich_text: { rich_text: [] },
  select: { select: null },
  multi_select: { multi_select: [] },
  number: { number: null },
  checkbox: { checkbox: false }
};

/**
 * Propiedades que buildProperties() escribe FUERA de PROP_MAP (meta + inferidas + grid + degradación).
 * Se exporta para que el script de esquema cree TODO lo necesario. 'Estado' es tipo status (la API
 * de Notion no crea opciones de status) → se omite; ya existe en la DB legacy.
 * Excluidas por existir en la DB v1 (legacy): Entrevistado(title), Tipo, Fecha, Fuente del contacto,
 * Notas principales, Telefono, Email — las crea la migración solo si faltan (ver META_PROPS abajo).
 */
export const META_PROPS = [
  ['Session ID', 'rich_text'], ['Último paso', 'number'], ['Completo', 'checkbox'],
  ['Idioma', 'select'], ['Fuente', 'select'], ['Duración (s)', 'number'],
  ['Cantidad de categorias', 'number'], ['Categoria dominante', 'select'],
  ['Nivel de dolor', 'number'], ['Receptividad al concepto', 'number'],
  ['Disposicion bundles', 'select'], ['Interes hurricane prep', 'select'],
  ['Proximo paso', 'select'], ['Frase textual clave', 'rich_text'],
  ['Precio aceptable mensual', 'rich_text'], ['Fuera ICP', 'checkbox'],
  ['Posible duplicado', 'checkbox'], ['H Recurrentes hoy', 'multi_select'],
  ['H Recurrentes detalle', 'rich_text'], ['H Recurrentes suma est.', 'number'],
  ['Overflow JSON', 'rich_text'],
  // legacy reusadas (se crean solo si faltan):
  ['Tipo', 'select'], ['Fuente del contacto', 'select'], ['Notas principales', 'rich_text'],
  ['Frase textual clave', 'rich_text']
];

/* payload key → [nombre propiedad Notion, builder] — TODOS los campos tienen destino */
export const PROP_MAP = {
  // proveedor (§2.3)
  p_screener: ['P Screener', SEL], p_business: ['P Negocio', RT], p_crew: ['P Tamaño crew', SEL],
  p_years: ['P Años oficio', SEL], p_service_area: ['P Área servicio', SEL],
  p_counties: ['P Condados servicio', MULTI], p_services: ['P Servicios', MULTI],
  p_services_other: ['P Servicio otro', RT], p_main: ['P Servicio principal', SEL],
  p_customers_12m: ['P Clientes 12m', SEL], p_repeat_pct: ['P % repetidos', SEL],
  p_plan_today: ['P Plan hoy', SEL], p_plan_count: ['P Plan # clientes', NUM],
  p_plan_price: ['P Plan precio/mes', SEL], p_billing: ['P Cómo cobra', MULTI],
  p_billing_other: ['P Cómo cobra otro', RT], p_plan_quit_why: ['P Plan por qué dejó', SEL],
  p_plan_quit_why_other: ['P Plan dejó texto', RT], p_recurring_3m: ['P Recurrentes 3m', SEL],
  p_revenue_band: ['P Facturación/mes', SEL], p_software: ['P Software', MULTI],
  p_software_other: ['P Software otro', RT], p_software_spend: ['P Gasto software/mes', SEL],
  p_software_pain: ['P Frustración software', RT], p_marketplace_spend: ['P Gasto leads/mes', SEL],
  p_lead_conversion: ['P Conversión leads', SEL], p_last_customer: ['P Último cliente canal', SEL],
  p_last_customer_other: ['P Último cliente otro', RT], p_pain_top: ['P Dolor #1', SEL],
  p_pain_top_other: ['P Dolor otro', RT], p_noshows: ['P No-shows semana', SEL],
  p_deposit: ['P Depósito', SEL], p_seasonal_pct: ['P % snowbirds', SEL],
  p_seasonality: ['P Estacionalidad', SEL], p_pain_story: ['P Historia dolor', RT],
  p_reaction: ['P Reacción', SEL], p_reaction_why: ['P Reacción por qué', RT],
  p_model_pref: ['P Modelo preferido', SEL], p_model_pref_why: ['P Modelo por qué', RT],
  // El nombre de la propiedad en Notion NO se renombra aunque la pregunta ya no diga 10%:
  // renombrarla crea columnas nuevas y parte el historico de respuestas en dos. Lo que se
  // pregunta hoy es $1,70 por socio y mes; lo respondido antes del 2026-08-11, el 10%.
  p_fee_10: ['P Comisión 10%', SEL], p_fee_10_incl: ['P 10% qué incluiría', RT],
  p_bundle_price: ['P Precio bundle', SEL], p_vw_expensive: ['P VW caro', NUM],
  p_vw_bargain: ['P VW ganga', NUM], p_blockers: ['P Frenos', MULTI],
  p_blockers_other: ['P Frenos otro', RT], p_commitment: ['P Compromiso', MULTI],

  // módulos verticales (proveedor)
  p_bb_service_price: ['BB Precio servicio core', NUM], p_bb_visit_freq: ['BB Frecuencia visita', SEL],
  p_bb_capacity: ['BB % agenda vacía', SEL], p_bb_slow_when: ['BB Cuándo se vacía', MULTI],
  p_bb_regulars: ['BB Clientes fijos', NUM], p_bb_walkins: ['BB Walk-ins vs citas', SEL],
  p_bb_structure: ['BB Estructura preferida', SEL], p_bb_addons: ['BB Add-ons tier', MULTI],
  p_bb_addons_other: ['BB Add-ons otro', RT], p_bb_credits: ['BB Créditos no usados', SEL],
  p_pet_subtype: ['PET Sub-tipo', SEL], p_pet_subtype_other: ['PET Sub-tipo otro', RT],
  p_pet_freq_groom: ['PET Frecuencia grooming', SEL], p_pet_freq_daycare: ['PET Frecuencia guardería', SEL],
  p_pet_freq_walk: ['PET Frecuencia paseo', SEL], p_pet_freq_board: ['PET Frecuencia hospedaje', SEL],
  p_pet_price_varies: ['PET Precio varía tamaño/pelo', CHK], p_pet_price_small: ['PET Precio perro chico', NUM],
  p_pet_price_large: ['PET Precio perro grande', NUM], p_pet_matting: ['PET Perro enredado/nervioso', SEL],
  p_pet_capacity: ['PET Cupos vacíos/semana', SEL], p_pet_structure: ['PET Estructura preferida', SEL],
  p_pet_unlimited_cap: ['PET Uso justo ilimitado', SEL], p_pet_extras_discount: ['PET Descuento extras hoy', SEL],
  p_pet_extras_pct: ['PET Descuento extras %', NUM], p_pet_multi_pet: ['PET Precio multi-mascota', SEL],
  p_pet_prepaid_tried: ['PET Prepago intentado', SEL], p_pet_prepaid_story: ['PET Prepago historia', RT],
  p_pet_requirements: ['PET Requisitos ingreso', MULTI], p_pet_requirements_other: ['PET Requisitos otro', RT],
  p_pet_founder_lock: ['PET Price-lock fundadores', SEL],
  p_food_optype: ['FOOD Tipo operación', SEL], p_food_commissary: ['FOOD Cocina/commissary', SEL],
  p_food_fulfillment: ['FOOD Entrega', MULTI], p_food_delivery_radius: ['FOOD Radio entrega', SEL],
  p_food_capacity: ['FOOD Capacidad/día', NUM], p_food_menu: ['FOOD Menú', SEL],
  p_food_prepaid: ['FOOD Prepago o fiado', SEL],
  p_fit_subtype: ['FIT Sub-tipo', SEL], p_fit_subtype_other: ['FIT Sub-tipo otro', RT],
  p_fit_capacity: ['FIT Capacidad clase', SEL], p_fit_peak: ['FIT Horario pico', MULTI],
  p_fit_churn: ['FIT Churn mensual', SEL], p_fit_structure: ['FIT Estructura preferida', SEL],
  p_fit_month_price: ['FIT Precio mensual', SEL], p_fit_contract: ['FIT Permanencia hoy', SEL],
  p_fit_prepay_long: ['FIT Prepago/contrato largo', SEL],
  p_staffing: ['P Modelo staffing', SEL], p_tips_prepaid: ['P Propina prepago', SEL],

  // homeowner (§2.4)
  h_screener: ['H Screener', SEL], h_property: ['H Propiedad', SEL], h_pool: ['H Piscina', CHK],
  h_lanai: ['H Lanai/screen', CHK], h_homewatch: ['H Home watch', SEL],
  h_household: ['H Hogar tipo', SEL], h_years_fl: ['H Años FL', SEL],
  h_services: ['H Servicios 12m', MULTI], h_services_other: ['H Servicio otro', RT],
  h_annual_prepay: ['H Paga anual', SEL], h_spend_annual: ['H Gasto anual', SEL],
  h_goto: ['H Proveedor de cabecera', SEL], h_discovery: ['H Descubrimiento', SEL],
  h_discovery_other: ['H Descubrimiento otro', RT], h_payment: ['H Método pago', MULTI],
  h_payment_other: ['H Método pago otro', RT], h_emergency_when: ['H Emergencia cuándo', SEL],
  h_emergency_exp: ['H Emergencia experiencia', SEL], h_emergency_story: ['H Emergencia historia', RT],
  h_hurricane: ['H Huracán gasto', SEL], h_hurricane_who: ['H Huracán quién', RT],
  h_pain_top: ['H Frustración #1', SEL], h_pain_top_other: ['H Frustración otro', RT],
  h_pain_story: ['H Historia factura', RT], h_reaction: ['H Reacción', SEL],
  h_reaction_why: ['H Reacción por qué', RT], h_vw_too_expensive: ['H VW demasiado caro', NUM],
  h_vw_expensive: ['H VW caro', NUM], h_vw_bargain: ['H VW ganga', NUM],
  h_vw_too_cheap: ['H VW demasiado barato', NUM], h_intent: ['H Intención (descontar)', SEL],
  h_expectations: ['H Debe incluir', MULTI], h_expectations_other: ['H Debe incluir otro', RT],
  h_priority_access: ['H Acceso prioritario', SEL], h_anything: ['H Algo más', RT],

  // meta (§2.2)
  vertical: ['Vertical', SEL],
  ref: ['Ref slug', RT], zip: ['ZIP', RT], city: ['Ciudad v2', RT], county: ['Condado', SEL],
  county_fips: ['County FIPS', RT], state: ['Estado US', SEL], country: ['País', SEL],
  utm: ['UTM', RT], sms_consent: ['Consent SMS (FTSA)', CHK], lang_pref: ['Idioma contacto', SEL]
};

/** Propiedades que existían en la DB v1 — set seguro para el intento degradado. */
const LEGACY_SAFE = new Set([
  'Entrevistado', 'Tipo', 'Estado', 'Fecha', 'Fuente del contacto',
  'Notas principales', 'Frase textual clave', 'Precio aceptable mensual',
  'Telefono', 'Email', 'Nivel de dolor', 'Receptividad al concepto',
  'Disposicion bundles', 'Cantidad de categorias', 'Categoria dominante',
  'Proximo paso', 'Interes hurricane prep'
]);

export function buildProperties(data, { isCreate, isDuplicate }) {
  const isFinal = !data.partial;
  const props = {};

  // ── legacy reusadas ──
  if (isCreate || data.name) {
    const title = data.name || `Anónimo ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    props['Entrevistado'] = { title: [{ text: { content: title.slice(0, 100) } }] };
  }
  props['Tipo'] = SEL(data.type);
  if (isCreate) props['Fecha'] = { date: { start: new Date().toISOString().slice(0, 10) } };
  props['Fuente del contacto'] = SEL(data.ref ? 'Referido' : 'Otro'); // mirror legacy
  props['Notas principales'] = RT(buildNotas(data));
  if (data.phone) props['Telefono'] = { phone_number: data.phone };
  if (data.email) props['Email'] = { email: data.email };

  // ── meta nuevas ──
  props['Session ID'] = RT(data.session_id);
  props['Último paso'] = NUM(data.step);
  // Completo (§fix #2): NUNCA degradar un final ya escrito. Un parcial que llega DESPUÉS del final
  // (botón "guardar email", beacon de pagehide con carrera de red) no debe bajar Completo→false.
  // Solo se escribe en el final (true) o al CREAR la página por primera vez (false, en progreso).
  if (isFinal || isCreate) props['Completo'] = CHK(isFinal);
  props['Idioma'] = SEL(data.lang);
  props['Fuente'] = SEL(!data.ref ? 'directo' : (data.ref.startsWith('zip-') ? 'referido-zip' : 'referido'));
  if (data.duration_s !== undefined) props['Duración (s)'] = NUM(data.duration_s);

  // ── respuestas 1:1 (solo presentes — un parcial nunca borra) ──
  for (const [key, [propName, build]] of Object.entries(PROP_MAP)) {
    const v = data[key];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && !v.length) continue;
    props[propName] = build(v);
  }

  // grid homeowner: 3 destinos
  if (data.h_recurring_grid) {
    const rows = Object.keys(data.h_recurring_grid.rows || {});
    if (rows.length) props['H Recurrentes hoy'] = MULTI(rows);
    else if (isFinal) props['H Recurrentes hoy'] = { multi_select: [] }; // final con grid vaciado: no dejar stale
    props['H Recurrentes detalle'] = RT(JSON.stringify({
      rows: data.h_recurring_grid.rows || {},
      ...(data.h_recurring_grid.other_text ? { other_text: data.h_recurring_grid.other_text } : {})
    }));
    const sum = gridSum(data.h_recurring_grid);
    if (sum !== null) props['H Recurrentes suma est.'] = NUM(sum);
  }

  // derivadas siempre disponibles
  if (Array.isArray(data.p_services) && data.p_services.length) {
    props['Cantidad de categorias'] = NUM(data.p_services.length);
  }
  if (data.p_main) props['Categoria dominante'] = SEL(data.p_main);

  // ── calculadas de submit FINAL (§2.5) ──
  if (isFinal) {
    props['Estado'] = { status: { name: 'Listo' } }; // única opción segura (API no crea status)
    const dolor = computeDolor(data);
    if (dolor !== null) props['Nivel de dolor'] = NUM(dolor);
    const recept = computeReceptividad(data);
    if (recept !== null) props['Receptividad al concepto'] = NUM(recept);
    props['Disposicion bundles'] = SEL(computeBundles(data));
    const hurr = computeHurricane(data);
    if (hurr) props['Interes hurricane prep'] = SEL(hurr);
    props['Proximo paso'] = SEL(computeProximoPaso(data));
    const frase = computeFrase(data);
    if (frase) props['Frase textual clave'] = RT(frase);
    if (data.type === 'provider' && data.p_bundle_price) {
      props['Precio aceptable mensual'] = RT(data.p_bundle_price);
    } else if (data.type === 'homeowner') {
      const vw = `VW: te=${data.h_vw_too_expensive ?? '-'} e=${data.h_vw_expensive ?? '-'} b=${data.h_vw_bargain ?? '-'} tc=${data.h_vw_too_cheap ?? '-'}`;
      props['Precio aceptable mensual'] = RT(vw);
    }
    props['Fuera ICP'] = CHK(computeFueraIcp(data));
    if (isDuplicate !== undefined) props['Posible duplicado'] = CHK(isDuplicate);

    // ── limpiar respuestas retractadas (§fix #5) ──
    // El final debe reflejar EXACTAMENTE el estado visible: se borran en Notion las props cuyas
    // respuestas ya no están presentes (ramas condicionales/other abandonadas por el usuario).
    if (Array.isArray(data.clears)) {
      for (const key of data.clears) {
        if (data[key] !== undefined) continue; // jamás pisar una respuesta presente
        if (key === 'h_recurring_grid') {
          if (!data.h_recurring_grid) {
            props['H Recurrentes hoy'] = { multi_select: [] };
            props['H Recurrentes detalle'] = { rich_text: [] };
            props['H Recurrentes suma est.'] = { number: null };
          }
          continue;
        }
        const map = PROP_MAP[key];
        if (!map) continue;
        const [propName, build] = map;
        const empty = EMPTY_BY_NT[build && build.nt];
        if (empty && props[propName] === undefined) props[propName] = empty;
      }
    }
  }

  return props;
}

/* ─────────────────────────── Notion helpers ─────────────────────────── */

async function notionFetch(path, method, body) {
  const doFetch = () => fetch(`${NOTION_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': NOTION_VERSION
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000)
  });
  let r = await doFetch();
  if (r.status === 429) { // rate limit Notion: 1 reintento con backoff
    const wait = Math.min(2000, (Number(r.headers.get('retry-after')) || 1) * 1000);
    await new Promise(ok => setTimeout(ok, wait));
    r = await doFetch();
  }
  return r;
}

function pagePlainText(page, propName) {
  try {
    const p = page.properties && page.properties[propName];
    if (!p || !Array.isArray(p.rich_text)) return '';
    return p.rich_text.map(t => t.plain_text || (t.text && t.text.content) || '').join('');
  } catch {
    return '';
  }
}

/** Resuelve el pageId existente para la sesión: page_id del cliente → KV → query DB. */
async function resolvePageId(data) {
  const sid = data.session_id;
  // a) page_id del cliente, verificado contra Session ID
  if (data.page_id) {
    try {
      const r = await notionFetch(`/pages/${data.page_id}`, 'GET');
      if (r.ok) {
        const page = await r.json();
        if (pagePlainText(page, 'Session ID') === sid) return page.id;
      }
    } catch { /* seguir */ }
  }
  // b) mapping en KV
  const cached = await kv('GET', `sess:${sid}:page`);
  if (typeof cached === 'string' && /^[0-9a-f-]{32,36}$/i.test(cached)) return cached;
  // c) query por Session ID (último recurso; la página nueva tarda ~1-2 s en indexar)
  try {
    const r = await notionFetch(`/databases/${DATABASE_ID}/query`, 'POST', {
      filter: { property: 'Session ID', rich_text: { equals: sid } },
      page_size: 1
    });
    if (r.ok) {
      const j = await r.json();
      if (j.results && j.results.length) return j.results[0].id;
    }
  } catch { /* seguir */ }
  return null;
}

/** Dedupe suave por email/teléfono (solo final, best-effort). */
async function checkDuplicate(data, excludePageId) {
  if (!data.email && !data.phone) return false;
  try {
    const or = [];
    if (data.email) or.push({ property: 'Email', email: { equals: data.email } });
    if (data.phone) or.push({ property: 'Telefono', phone_number: { equals: data.phone } });
    const r = await notionFetch(`/databases/${DATABASE_ID}/query`, 'POST', {
      filter: or.length > 1 ? { or } : or[0],
      page_size: 3
    });
    if (!r.ok) return false;
    const j = await r.json();
    return (j.results || []).some(p => p.id !== excludePageId);
  } catch {
    return false;
  }
}

const RX_UNKNOWN_PROP = /^(.+?) is not a property that exists/i;

/**
 * Escribe la página con degradación: si Notion rechaza propiedades inexistentes,
 * las quita (hasta 4 iteraciones), y si sigue fallando cae al set legacy-safe +
 * Overflow JSON. NUNCA tira la respuesta.
 */
async function writePage(pageId, props, data) {
  const send = p => pageId
    ? notionFetch(`/pages/${pageId}`, 'PATCH', { properties: p })
    : notionFetch('/pages', 'POST', { parent: { database_id: DATABASE_ID }, properties: p });

  let current = { ...props };
  const removed = {};

  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await send(current);
    if (r.ok) {
      const j = await r.json();
      const okPageId = j.id || pageId;
      if (Object.keys(removed).length) {
        // lo removido no puede perderse: log completo + Overflow JSON best-effort
        const overflow = JSON.stringify({ session_id: data.session_id, removed_props: Object.keys(removed), answers: data });
        console.error('[submit] Notion aceptó en modo degradado; propiedades sin destino:',
          Object.keys(removed).join(', '), '— corre scripts/setup-notion-schema.mjs',
          '\n[submit] OVERFLOW_RESCUE:', overflow.slice(0, 8000));
        if (okPageId) {
          await notionFetch(`/pages/${okPageId}`, 'PATCH', {
            properties: { 'Overflow JSON': RT(overflow) }
          }).catch(() => {}); // si 'Overflow JSON' tampoco existe, ya quedó en logs
        }
      }
      return { ok: true, pageId: okPageId, degraded: Object.keys(removed).length > 0 };
    }
    const errText = await r.text().catch(() => '');
    if (r.status !== 400) {
      return { ok: false, status: r.status, error: errText };
    }
    let message = '';
    try { message = JSON.parse(errText).message || ''; } catch { message = errText; }
    const m = RX_UNKNOWN_PROP.exec(message);
    if (m && attempt < 3) {
      const bad = m[1].trim();
      if (current[bad] !== undefined) {
        console.error(`[submit] Notion: propiedad inexistente "${bad}" — reintento sin ella`);
        removed[bad] = current[bad];
        delete current[bad];
        continue;
      }
    }
    // 400 no recuperable por remoción puntual → intento legacy-safe + Overflow JSON
    console.error('[submit] Notion 400 — degradando a legacy-safe + Overflow JSON:', message.slice(0, 500));
    const safe = {};
    for (const [k, v] of Object.entries(props)) if (LEGACY_SAFE.has(k)) safe[k] = v;
    if (!pageId && !safe['Entrevistado']) {
      safe['Entrevistado'] = { title: [{ text: { content: `Anónimo ${new Date().toISOString()}` } }] };
    }
    const overflowJson = JSON.stringify({ session_id: data.session_id, answers: data });
    let r2 = await send({ ...safe, 'Overflow JSON': RT(overflowJson) });
    if (r2.ok) {
      const j2 = await r2.json();
      return { ok: true, pageId: j2.id || pageId, degraded: true };
    }
    // ni siquiera existe 'Overflow JSON' → volcarlo dentro de Notas principales
    safe['Notas principales'] = { rich_text: rtChunks(`${buildNotas(data)}\n--- OVERFLOW JSON ---\n${overflowJson}`) };
    r2 = await send(safe);
    if (r2.ok) {
      const j2 = await r2.json();
      console.error('[submit] guardado degradado con overflow dentro de Notas principales');
      return { ok: true, pageId: j2.id || pageId, degraded: true };
    }
    const finalErr = await r2.text().catch(() => '');
    return { ok: false, status: r2.status, error: finalErr };
  }
  return { ok: false, status: 400, error: 'max retries' };
}

/* ─────────────────────────── handler ─────────────────────────── */

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim().slice(0, 45);
  return (req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown').toString().slice(0, 45);
}

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    if (body.length > MAX_BODY_BYTES) return { tooBig: true };
    try { body = JSON.parse(body); } catch { return { invalid: true }; }
  }
  if (Buffer.isBuffer(body)) {
    if (body.length > MAX_BODY_BYTES) return { tooBig: true };
    try { body = JSON.parse(body.toString('utf8')); } catch { return { invalid: true }; }
  }
  return { body };
}

export default async function handler(req, res) {
  const corsOk = applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(corsOk ? 204 : 403).end();
  if (!corsOk) return res.status(403).json({ error: 'forbidden' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  if (!NOTION_TOKEN) {
    console.error('[submit] falta NOTION_TOKEN');
    return res.status(500).json({ error: 'server_not_configured' });
  }

  const cl = Number(req.headers['content-length']);
  if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) return res.status(413).json({ error: 'too_large' });

  const parsed = parseBody(req);
  if (parsed.tooBig) return res.status(413).json({ error: 'too_large' });
  if (parsed.invalid || !parsed.body) return res.status(400).json({ error: 'validation' });
  const raw = parsed.body;

  // 1) honeypot: campo oculto lleno = bot → 200 fake (no revelar)
  if (typeof raw.website === 'string' && raw.website.trim().length > 0) {
    console.warn('[submit] honeypot lleno — descartado');
    return res.status(200).json({ success: true });
  }

  // 2) validación estricta por contrato
  const v = validatePayload(raw);
  if (!v.ok) return res.status(400).json({ error: 'validation' });
  const data = v.data;
  const isFinal = !data.partial;
  const ip = clientIp(req);

  try {
    // 3) rate limit (memoria + KV gateado)
    if (await rateLimited(ip, isFinal)) {
      return res.status(429).json({ error: 'rate_limited' });
    }

    // 4) t0 de sesión en KV (primer contacto) — base del tiempo mínimo sin HMAC.
    //    §fix menor: AWAIT el SET NX para que la ruta 1 de failsMinTime (t0 en KV, no manipulable por
    //    el cliente) dispare de forma confiable también en un FINAL de primer contacto (sin parciales
    //    previos). Sin await, el GET de failsMinTime corría carrera con este SET y podía caer al
    //    fallback por ts_start del cliente, que un bot puede falsear con un ts_start viejo.
    if (KV_ON) {
      try { await kv('SET', `sess:${data.session_id}:t0`, Date.now(), 'NX', 'EX', 172800); } catch (e) {}
    }

    // 5) tiempo mínimo de llenado (solo final) → 200 fake
    if (await failsMinTime(data)) {
      console.warn(`[submit] final demasiado rápido/firma inválida (sid=${data.session_id}) — descartado`);
      return res.status(200).json({ success: true });
    }

    // 6) Turnstile (gateado por TURNSTILE_SECRET, solo final)
    if (!(await turnstileOk(data, ip))) {
      return res.status(400).json({ error: 'validation' });
    }

    // 7) upsert Notion
    const pageId = await resolvePageId(data);
    const isDuplicate = isFinal ? await checkDuplicate(data, pageId) : undefined;
    const props = buildProperties(data, { isCreate: !pageId, isDuplicate });
    const result = await writePage(pageId, props, data);

    if (!result.ok) {
      // resiliencia: jamás perder la respuesta
      const dump = JSON.stringify({ ts: Date.now(), notion_status: result.status, payload: data });
      if (KV_ON) {
        await kv('LPUSH', 'queue:failed', dump);
        await kv('LTRIM', 'queue:failed', 0, 999);
      }
      console.error('[submit] Notion falló — respuesta encolada/volcada a logs:', result.status,
        String(result.error).slice(0, 400), '\n[submit] PAYLOAD_RESCUE:', dump.slice(0, 8000));
      return res.status(200).json({ success: true, queued: true });
    }

    // 8) housekeeping best-effort (no bloquea la respuesta)
    if (KV_ON && result.pageId) {
      kv('SET', `sess:${data.session_id}:page`, result.pageId, 'EX', 604800).catch(() => {});
      if (isFinal) {
        if (data.zip) kv('INCR', `stats:zip:${data.zip}`).catch(() => {});
        if (data.ref) kv('INCR', `stats:ref:${data.ref}`).catch(() => {});
      }
    }

    return res.status(200).json({ success: true, pageId: result.pageId });
  } catch (err) {
    console.error('[submit] error inesperado:', err, '\n[submit] PAYLOAD_RESCUE:',
      JSON.stringify(data).slice(0, 8000));
    // el cliente reintenta el parcial siguiente; el final se rescata de los logs
    return res.status(200).json({ success: true, queued: true });
  }
}
