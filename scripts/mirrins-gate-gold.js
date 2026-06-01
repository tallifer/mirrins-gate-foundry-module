// scripts/mirrins-gate-gold.js
// Watches the configured PF2e Party actor's coin total and POSTs it to the
// Mirrin's Gate marketplace webhook whenever it changes (and once on startup).
// GM-only.

const MODULE_ID = 'mirrins-gate-gold';
const LOG_PREFIX = `[${MODULE_ID}]`;
const DEBOUNCE_MS = 300;
const NOTIFICATION_THROTTLE_MS = 30_000;
const COIN_DENOMINATIONS_CP = { pp: 1000, gp: 100, sp: 10, cp: 1 };

let pendingPushTimer = null;
let lastSentGoldCp = null;
let lastNotificationAt = 0;
let lastWarnMessage = '';

function log(...args)   { console.log(LOG_PREFIX, ...args); }
function debug(...args) { console.debug(LOG_PREFIX, ...args); }
function warn(...args)  { console.warn(LOG_PREFIX, ...args); }

// Suppress consecutive duplicate warnings so a persistent misconfig doesn't
// fill the console on every hook firing.
function warnDeduped(msg) {
  if (msg === lastWarnMessage) return;
  lastWarnMessage = msg;
  warn(msg);
}

function notifyWarnThrottled(msg) {
  const now = Date.now();
  if (now - lastNotificationAt < NOTIFICATION_THROTTLE_MS) return;
  lastNotificationAt = now;
  ui.notifications?.warn(`Mirrin's Gate: ${msg}`);
}

function isPf2e() {
  return game.system?.id === 'pf2e';
}

function isCoinItem(item) {
  if (!item) return false;
  if (item.system?.stackGroup === 'coins') return true;
  if (item.type === 'treasure' && item.system?.denomination) return true;
  return false;
}

// Fallback path: sum coin items directly when the system getter isn't available.
function sumCoinsItemwise(actor) {
  let total = 0;
  let found = false;
  for (const item of actor.items ?? []) {
    if (!isCoinItem(item)) continue;
    const denom = item.system?.denomination?.value ?? item.system?.denomination;
    const qty = item.system?.quantity ?? 0;
    const multiplier = COIN_DENOMINATIONS_CP[denom];
    if (multiplier && Number.isFinite(qty)) {
      total += qty * multiplier;
      found = true;
    }
  }
  return found ? total : null;
}

// Returns the actor's total wealth in copper pieces, or null if it can't be resolved.
function getPartyGoldCp(actor) {
  if (!actor) return null;
  const summary = actor.inventory?.coins;
  // Require at least one expected denomination key on the summary so a shape
  // change in PF2e doesn't silently zero out the party's gold.
  if (summary && typeof summary === 'object'
      && ('pp' in summary || 'gp' in summary || 'sp' in summary || 'cp' in summary)) {
    const { pp = 0, gp = 0, sp = 0, cp = 0 } = summary;
    const total = pp * 1000 + gp * 100 + sp * 10 + cp;
    if (Number.isFinite(total)) return Math.round(total);
  }
  const itemwise = sumCoinsItemwise(actor);
  if (itemwise !== null) return Math.round(itemwise);
  warnDeduped(`Could not resolve coin total for actor "${actor?.name}".`);
  return null;
}

// Silent lookup — no side effects, safe for hot-path filters.
function findConfiguredPartyActor() {
  const configuredId = game.settings.get(MODULE_ID, 'partyActorId');
  if (configuredId) return game.actors.get(configuredId) ?? null;
  const parties = game.actors.filter((a) => a.type === 'party');
  return parties.length === 1 ? parties[0] : null;
}

// Same lookup, but logs (deduped) when resolution fails. Use from the active
// push path, not from filter predicates.
function findConfiguredPartyActorVerbose() {
  const configuredId = game.settings.get(MODULE_ID, 'partyActorId');
  if (configuredId) {
    const actor = game.actors.get(configuredId);
    if (!actor) warnDeduped(`Configured party actor id "${configuredId}" not found in world.`);
    return actor ?? null;
  }
  const parties = game.actors.filter((a) => a.type === 'party');
  if (parties.length === 1) return parties[0];
  if (parties.length > 1) {
    warnDeduped(`Multiple party actors found (${parties.length}); set "Party actor id" to disambiguate.`);
  } else {
    warnDeduped('No party actor configured and none found in world.');
  }
  return null;
}

function affectsConfiguredActor(actorOrItem) {
  if (!actorOrItem) return false;
  const actor = actorOrItem.parent ?? actorOrItem;
  const configured = findConfiguredPartyActor();
  return !!configured && actor?.id === configured.id;
}

async function postGoldToWebhook(goldCp) {
  const url = game.settings.get(MODULE_ID, 'webhookUrl');
  const secret = game.settings.get(MODULE_ID, 'webhookSecret');
  if (!url || !secret) {
    warnDeduped('Webhook URL or secret not configured; skipping send.');
    return { ok: false, reason: 'unconfigured' };
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': secret,
      },
      body: JSON.stringify({ gold_cp: goldCp }),
    });
    return { ok: res.ok, status: res.status, statusText: res.statusText };
  } catch (err) {
    return { ok: false, reason: 'network', error: err };
  }
}

async function pushGold(goldCp) {
  if (!Number.isInteger(goldCp) || goldCp < 0) {
    warnDeduped(`Refusing to send invalid gold value: ${goldCp}`);
    return;
  }
  const result = await postGoldToWebhook(goldCp);
  if (result.reason === 'unconfigured') return;
  if (result.reason === 'network') {
    warn('Network error pushing gold:', result.error);
    notifyWarnThrottled('webhook unreachable (see console).');
    return;
  }
  if (!result.ok) {
    warnDeduped(`Webhook returned ${result.status} ${result.statusText}.`);
    notifyWarnThrottled(`webhook returned ${result.status}; check settings.`);
    return;
  }
  lastWarnMessage = '';
  debug(`Pushed gold_cp=${goldCp}`);
}

function executePush() {
  const actor = findConfiguredPartyActorVerbose();
  if (!actor) return;
  const gold = getPartyGoldCp(actor);
  if (gold === null) return;
  if (gold === lastSentGoldCp) {
    debug(`Gold unchanged (${gold} cp); skipping send.`);
    return;
  }
  lastSentGoldCp = gold;
  pushGold(gold);
}

function schedulePush() {
  if (!game.user?.isGM) return;
  if (pendingPushTimer) clearTimeout(pendingPushTimer);
  pendingPushTimer = setTimeout(() => {
    pendingPushTimer = null;
    executePush();
  }, DEBOUNCE_MS);
}

// Triggered from the "Test webhook" settings menu. Forces a send regardless
// of the cached last value and reports the result via UI notifications.
async function runTestWebhook() {
  if (!game.user?.isGM) return;
  const url = game.settings.get(MODULE_ID, 'webhookUrl');
  const secret = game.settings.get(MODULE_ID, 'webhookSecret');
  if (!url || !secret) {
    ui.notifications?.error("Mirrin's Gate: webhook URL and secret must be set first.");
    return;
  }
  const actor = findConfiguredPartyActorVerbose();
  if (!actor) {
    ui.notifications?.error("Mirrin's Gate: no party actor resolved. Set 'Party actor id' or ensure exactly one party actor exists.");
    return;
  }
  const gold = getPartyGoldCp(actor);
  if (gold === null) {
    ui.notifications?.error("Mirrin's Gate: couldn't read the party's coin total. See console.");
    return;
  }
  ui.notifications?.info(`Mirrin's Gate: sending test ping (${gold} cp)…`);
  const result = await postGoldToWebhook(gold);
  if (result.reason === 'network') {
    ui.notifications?.error("Mirrin's Gate: test failed — network error. See console.");
    warn('Test webhook network error:', result.error);
    return;
  }
  if (result.ok) {
    lastSentGoldCp = gold;
    ui.notifications?.info(`Mirrin's Gate: test successful (HTTP ${result.status}).`);
  } else {
    ui.notifications?.error(`Mirrin's Gate: test failed — HTTP ${result.status} ${result.statusText}.`);
  }
}

// Minimal FormApplication shim: opens a confirmation Dialog when the settings
// menu button is clicked, then suppresses its own render lifecycle.
class TestWebhookForm extends FormApplication {
  constructor() {
    super({});
    new Dialog({
      title: "Mirrin's Gate — Test webhook",
      content: '<p>Send a test ping with the current party gold to the configured webhook?</p>',
      buttons: {
        send: {
          icon: '<i class="fas fa-paper-plane"></i>',
          label: 'Send',
          callback: () => runTestWebhook(),
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: 'Cancel',
        },
      },
      default: 'send',
    }).render(true);
  }
  async render() { return this; }
  async close() { return this; }
  async _updateObject() { return this; }
}

Hooks.once('init', () => {
  game.settings.register(MODULE_ID, 'webhookUrl', {
    name: 'Webhook URL',
    hint: "Full URL of the Mirrin's Gate Supabase Edge Function (e.g. https://<project>.supabase.co/functions/v1/foundry-gold-webhook).",
    scope: 'world',
    config: true,
    type: String,
    default: '',
    restricted: true,
  });

  game.settings.register(MODULE_ID, 'webhookSecret', {
    name: 'Webhook secret',
    hint: 'Shared secret — must match FOUNDRY_WEBHOOK_SECRET set in Supabase. Treat as sensitive: anyone with this value can post arbitrary gold updates.',
    scope: 'world',
    config: true,
    type: String,
    default: '',
    restricted: true,
  });

  game.settings.register(MODULE_ID, 'partyActorId', {
    name: 'Party actor id',
    hint: "Leave blank to auto-detect when the world has exactly one Party actor. Otherwise paste the actor id (the long alphanumeric string visible in the actor sheet's window header tooltip, or via the macro in this module's README).",
    scope: 'world',
    config: true,
    type: String,
    default: '',
    restricted: true,
  });

  // ── Purchase processor settings (v0.2) ──
  // The processor only starts when all three are set and processorEnabled is on.
  // Leaving them blank keeps the v0.1 gold-push running with no processor.
  game.settings.register(MODULE_ID, 'supabaseUrl', {
    name: 'Supabase URL',
    hint: 'Your Supabase project URL (e.g. https://<project>.supabase.co). Required for the purchase processor; leave blank to run gold-sync only.',
    scope: 'world',
    config: true,
    type: String,
    default: '',
    restricted: true,
  });

  game.settings.register(MODULE_ID, 'supabaseServiceRoleKey', {
    name: 'Supabase service-role key',
    hint: 'The service-role key from Supabase → Project Settings → API. SENSITIVE: it bypasses all row security. Anyone with GM access to this world can read it, so do not grant players GM while it is set. Required for the purchase processor.',
    scope: 'world',
    config: true,
    type: String,
    default: '',
    restricted: true,
  });

  game.settings.register(MODULE_ID, 'processorEnabled', {
    name: 'Enable purchase processor',
    hint: 'Master kill-switch for processing website purchases (claim, deduct gold, grant items). Turn off to pause processing without clearing the URL/key. Has no effect on gold-sync.',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
    restricted: true,
  });

  game.settings.registerMenu(MODULE_ID, 'testWebhook', {
    name: 'Test webhook',
    label: 'Send test ping',
    hint: 'Sends the current party gold to the webhook now and reports the result. Use after configuring the three settings above.',
    icon: 'fas fa-paper-plane',
    type: TestWebhookForm,
    restricted: true,
  });
});

Hooks.once('ready', () => {
  if (!game.user?.isGM) return;
  if (!isPf2e()) {
    warn(`Inactive: this module requires the PF2e system (current: ${game.system?.id ?? 'unknown'}).`);
    return;
  }
  log('Ready. Pushing initial gold value.');
  schedulePush();
});

Hooks.on('updateActor', (actor) => {
  if (!game.user?.isGM || !isPf2e()) return;
  if (!affectsConfiguredActor(actor)) return;
  // Coin changes in PF2e flow through item hooks, but recompute defensively
  // for any actor-level update on the configured party. The cached
  // last-sent value short-circuits the eventual send if nothing changed.
  schedulePush();
});

for (const hookName of ['createItem', 'updateItem', 'deleteItem']) {
  Hooks.on(hookName, (item) => {
    if (!game.user?.isGM || !isPf2e()) return;
    if (!affectsConfiguredActor(item)) return;
    if (!isCoinItem(item)) return;
    schedulePush();
  });
}

// ═════════════════════════════════════════════════════════════════════════
// PURCHASE PROCESSOR (v0.2) — GM-only.
//
// When the active GM has Foundry open, pending website purchases are claimed
// atomically (pending -> processing via the claim_purchase RPC, so two GM
// clients can race without double-fulfilling), validated, fulfilled (party gold
// deducted, items granted to the buyer's mapped character), then marked
// completed — or rejected with stock restored.
//
// The Supabase client is loaded with a *dynamic* import so a blocked CDN (e.g.
// The Forge's CSP) disables only the processor; the v0.1 gold-push above keeps
// working regardless.
// ═════════════════════════════════════════════════════════════════════════

const PROC_PREFIX = `${LOG_PREFIX} proc:`;
const HEARTBEAT_MS = 15_000;
const SUPABASE_ESM = 'https://esm.sh/@supabase/supabase-js@2';

let sb = null;               // Supabase service-role client (null until started)
let processorStarted = false;
let heartbeatTimer = null;
let packIndexCache = null;   // [{ pack, index }], cached for the processor's run
const purchaseQueue = [];    // FIFO of raw purchase rows awaiting processing
let draining = false;

function plog(...args)   { console.log(PROC_PREFIX, ...args); }
function pdebug(...args) { console.debug(PROC_PREFIX, ...args); }
function pwarn(...args)  { console.warn(PROC_PREFIX, ...args); }

function processorConfigured() {
  return !!game.settings.get(MODULE_ID, 'supabaseUrl')
      && !!game.settings.get(MODULE_ID, 'supabaseServiceRoleKey');
}

// Re-checked on every event, not just at startup, so toggling the kill-switch
// or dropping the GM role mid-session takes effect immediately.
function processorActive() {
  return !!game.user?.isGM
      && isPf2e()
      && game.settings.get(MODULE_ID, 'processorEnabled') === true;
}

// PF2e price.value accepts a partial coins object; decompose cp for tidy display.
function cpToPriceObject(cp) {
  let rest = Math.max(0, Math.round(Number(cp) || 0));
  const gp = Math.floor(rest / 100); rest -= gp * 100;
  const sp = Math.floor(rest / 10);  rest -= sp * 10;
  return { gp, sp, cp: rest };
}

// Cache each Item compendium's index once per run, then reuse. Same
// case-insensitive name match the original purchase macro used.
async function getItemPackIndexes() {
  if (packIndexCache) return packIndexCache;
  const entries = [];
  for (const pack of game.packs.filter((pk) => pk.metadata.type === 'Item')) {
    try {
      entries.push({ pack, index: await pack.getIndex() });
    } catch (err) {
      pwarn(`failed to index pack "${pack?.metadata?.id}"`, err);
    }
  }
  packIndexCache = entries;
  return entries;
}

async function findCompendiumItemObject(name) {
  if (!name) return null;
  const target = String(name).toLowerCase();
  for (const { pack, index } of await getItemPackIndexes()) {
    const entry = index.find((e) => e.name?.toLowerCase() === target);
    if (entry) {
      const doc = await pack.getDocument(entry._id);
      return doc?.toObject() ?? null;
    }
  }
  return null;
}

// Barebones PF2e item for homebrew lines (no compendium match expected). The
// shape mirrors a real `equipment` item's source data so createEmbeddedDocuments
// validates cleanly. Defaults to `equipment`; the DM can refine afterwards.
function buildHomebrewItemObject(line, qty) {
  return {
    name: line.display_name || line.foundry_name || 'Homebrew Item',
    type: 'equipment',
    img: 'icons/svg/item-bag.svg',
    system: {
      baseItem: null,
      bulk: { value: 0 },
      containerId: null,
      description: { value: '' },
      hardness: 0,
      hp: { value: 0, max: 0 },
      level: { value: 0 },
      material: { grade: null, type: null },
      price: { value: cpToPriceObject(line.unit_cp ?? 0) },
      quantity: qty,
      rules: [],
      size: 'med',
      traits: { rarity: 'common', value: [] },
      usage: { value: 'held-in-one-hand' },
    },
  };
}

function summarizePurchase(items) {
  return (items ?? [])
    .map((i) => `${i.quantity}× ${i.display_name || i.foundry_name || 'item'}`)
    .join(', ');
}

async function rejectPurchase(id, status, reason) {
  pwarn(`rejected ${id} as ${status}: ${reason}`);
  const { error } = await sb.rpc('cancel_purchase', {
    purchase_id: id, new_status: status, reason,
  });
  if (error) pwarn(`cancel_purchase RPC failed for ${id}`, error);
  ui.notifications?.warn(`Mirrin's Gate: purchase rejected — ${reason}`);
}

// Claim -> validate -> fulfil -> complete (or reject). Throws only when a row
// is left mid-fulfilment (`processing`) for manual recovery; the queue catches
// it and continues.
async function processPurchase(rawRow) {
  if (!processorActive() || !sb) return;
  const rawId = rawRow?.id;
  if (!rawId) return;

  // 1. Atomic claim. Exactly one client moves the row pending -> processing.
  const { data: claimData, error: claimErr } = await sb.rpc('claim_purchase', { purchase_id: rawId });
  if (claimErr) { pwarn(`claim error for ${rawId}`, claimErr); return; }
  const claimed = Array.isArray(claimData) ? claimData[0] : claimData;
  if (!claimed?.id) {
    pdebug(`claim failed for ${rawId} (already processed by another client)`);
    return;
  }

  const items = Array.isArray(claimed.items) ? claimed.items : [];
  const totalCp = Number(claimed.total_cp) || 0;

  // 2. Buyer mapping.
  const { data: mapping, error: mapErr } = await sb
    .from('user_characters')
    .select('actor_id, display_name')
    .eq('user_id', claimed.user_id)
    .maybeSingle();
  if (mapErr)   { await rejectPurchase(claimed.id, 'rejected_other', 'could not read buyer mapping'); return; }
  if (!mapping) { await rejectPurchase(claimed.id, 'rejected_other', 'buyer has no character mapping'); return; }

  plog(`picked up ${claimed.id} for ${mapping.display_name}, total ${totalCp} cp, ${items.length} item(s)`);

  // 3. Buyer actor.
  const buyerActor = game.actors.get(mapping.actor_id);
  if (!buyerActor) { await rejectPurchase(claimed.id, 'rejected_other', "buyer's character actor not found in this world"); return; }

  // 4. Party actor.
  const party = findConfiguredPartyActorVerbose();
  if (!party) { await rejectPurchase(claimed.id, 'rejected_other', 'party actor not found'); return; }

  // 5. Funds (fast pre-check; removeCoins re-checks authoritatively below).
  const partyCp = getPartyGoldCp(party);
  if (partyCp === null) { await rejectPurchase(claimed.id, 'rejected_other', 'could not read party gold'); return; }
  if (partyCp < totalCp) {
    await rejectPurchase(claimed.id, 'rejected_insufficient_funds', `party has ${partyCp} cp, purchase costs ${totalCp} cp`);
    return;
  }

  // 6. Resolve every item *before* touching gold, so a compendium miss rejects
  //    with no side effects.
  // TODO(town-state-migration): revalidate item visibility against current town
  // state once town state lives in Supabase. See TODO.md.
  const toCreate = [];
  for (const line of items) {
    const qty = Math.max(1, Number(line.quantity) || 1);
    if (line.is_homebrew) {
      toCreate.push(buildHomebrewItemObject(line, qty));
    } else {
      const obj = await findCompendiumItemObject(line.foundry_name || line.display_name);
      if (!obj) {
        await rejectPurchase(claimed.id, 'rejected_other', `item '${line.foundry_name || line.display_name}' not found in any compendium`);
        return;
      }
      obj.system = obj.system || {};
      obj.system.quantity = qty;
      toCreate.push(obj);
    }
  }

  if (typeof party.inventory?.removeCoins !== 'function') {
    await rejectPurchase(claimed.id, 'rejected_other', 'party actor has no coin API (unexpected PF2e version)');
    return;
  }

  // 7. Deduct gold. removeCoins by value makes change and returns false if the
  //    party can't pay; on false nothing was removed, so we reject cleanly.
  let paid;
  try {
    paid = await party.inventory.removeCoins({ cp: totalCp }, { byValue: true });
  } catch (err) {
    // Can't be sure whether coins moved — leave the row stuck in `processing`
    // for manual recovery rather than guess. Bubbles to the queue handler.
    pwarn(`error deducting gold for ${claimed.id}`, err);
    throw err;
  }
  if (!paid) {
    await rejectPurchase(claimed.id, 'rejected_insufficient_funds', `party could not pay ${totalCp} cp`);
    return;
  }

  // 8. Grant items. If this throws, gold is already gone and the row stays
  //    `processing` (a visible stuck row). See README / TODO.md for recovery.
  await buyerActor.createEmbeddedDocuments('Item', toCreate);

  // 9. Mark completed.
  const { error: compErr } = await sb.rpc('complete_purchase', { purchase_id: claimed.id });
  if (compErr) { pwarn(`complete_purchase RPC failed for ${claimed.id}`, compErr); throw compErr; }

  plog(`completed ${claimed.id}`);
  // 10. Toast.
  ui.notifications?.info(`Mirrin's Gate: ${mapping.display_name} purchased ${summarizePurchase(items)}.`);
  // 11. Push the new party gold immediately rather than waiting for the coin
  //     hooks' debounce — race-free, instant marketplace feedback.
  executePush();
}

// Serial queue: one worker, never parallel, continue on error.
function enqueuePurchase(row) {
  if (!row?.id) return;
  purchaseQueue.push(row);
  drainQueue();
}

async function drainQueue() {
  if (draining) return;
  draining = true;
  try {
    while (purchaseQueue.length) {
      const row = purchaseQueue.shift();
      try {
        await processPurchase(row);
      } catch (err) {
        pwarn(`error processing ${row?.id} (queue continues)`, err);
      }
    }
  } finally {
    draining = false;
  }
}

async function sendHeartbeat() {
  if (!processorActive() || !sb) return;
  try {
    const { error } = await sb.from('gm_presence')
      .upsert({ id: 1, updated_at: new Date().toISOString() });
    if (error) pdebug('heartbeat upsert failed', error);
  } catch (err) {
    pdebug('heartbeat error', err);
  }
}

function subscribePurchaseInserts() {
  return sb.channel('mg-purchase-processor')
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'purchases', filter: 'status=eq.pending' },
      (payload) => {
        if (!processorActive()) return;
        enqueuePurchase(payload.new);
      })
    .subscribe((status) => pdebug(`realtime subscription: ${status}`));
}

async function bootScan() {
  const { data, error } = await sb.from('purchases')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) { pwarn('boot scan query failed', error); return; }
  pdebug(`boot scan found ${data?.length ?? 0} pending purchase(s)`);
  for (const row of data ?? []) enqueuePurchase(row);
}

async function startProcessor() {
  if (processorStarted) return;
  if (!game.user?.isGM || !isPf2e()) return;
  if (game.settings.get(MODULE_ID, 'processorEnabled') !== true) {
    log('proc: disabled by the "Enable purchase processor" setting.');
    return;
  }
  if (!processorConfigured()) {
    log('proc: disabled — set "Supabase URL" and "Supabase service-role key" to enable.');
    return;
  }

  let createClient;
  try {
    ({ createClient } = await import(SUPABASE_ESM));
  } catch (err) {
    pwarn(`failed to load supabase-js from ${SUPABASE_ESM}; processor disabled for this session (gold-sync unaffected).`, err);
    return;
  }

  try {
    sb = createClient(
      game.settings.get(MODULE_ID, 'supabaseUrl'),
      game.settings.get(MODULE_ID, 'supabaseServiceRoleKey'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  } catch (err) {
    pwarn('failed to create Supabase client; processor disabled for this session.', err);
    sb = null;
    return;
  }

  processorStarted = true;
  log('proc: started. Heartbeat + boot scan + realtime active.');

  // Heartbeat first so presence appears promptly.
  sendHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);

  // Subscribe BEFORE the boot scan so a purchase created during startup can't
  // slip through the gap; any overlap is harmless (claim_purchase dedupes).
  try { subscribePurchaseInserts(); } catch (err) { pwarn('realtime subscribe failed', err); }
  try { await bootScan(); } catch (err) { pwarn('boot scan failed', err); }
}

Hooks.once('ready', () => {
  // Separate ready hook from the gold-push one so the processor can never
  // affect v0.1 behaviour.
  startProcessor().catch((err) => pwarn('startup error', err));
});
