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
    hint: 'Shared secret — must match FOUNDRY_WEBHOOK_SECRET in Supabase (gold-webhook) and Netlify (purchase broker). SENSITIVE: with this value an attacker can post arbitrary gold updates AND drive the purchase broker — claim/complete/cancel purchases and read purchase rows + buyer character mappings. GM-only; do not give players GM access while it is populated.',
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

  // ── Purchase processor settings (v0.2.1) ──
  // The processor only starts when the Processor URL and Webhook secret are both
  // set and processorEnabled is on. Leaving the Processor URL blank keeps the
  // v0.1 gold-push running with no processor.
  game.settings.register(MODULE_ID, 'processorUrl', {
    name: 'Processor URL',
    hint: "Full URL of the Mirrin's Gate Netlify broker function (e.g. https://<site>.netlify.app/.netlify/functions/foundry-processor). Required for the purchase processor; leave blank to run gold-sync only. Authenticated with the Webhook secret above — no service-role key lives in Foundry any more.",
    scope: 'world',
    config: true,
    type: String,
    default: '',
    restricted: true,
  });

  game.settings.register(MODULE_ID, 'processorEnabled', {
    name: 'Enable purchase processor',
    hint: 'Master kill-switch for processing website purchases (claim, deduct gold, grant items). Turn off to pause processing without clearing the Processor URL. Has no effect on gold-sync.',
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
// PURCHASE PROCESSOR (v0.2.1) — GM-only.
//
// When the active GM has Foundry open, pending website purchases are claimed
// atomically (pending -> processing via the claim_purchase RPC, so two GM
// clients can race without double-fulfilling), validated, fulfilled (party gold
// deducted, items granted to the buyer's mapped character), then marked
// completed — or rejected with stock restored.
//
// Supabase blocks service-role calls from a browser origin, so all data access
// goes through the Mirrin's Gate Netlify broker function (see callProcessor):
// Foundry authenticates with the shared webhook secret and the broker holds the
// service-role key server-side. Pending purchases are discovered by polling the
// broker's list-pending action every 10s (no Realtime, no esm.sh import); the
// GM-presence heartbeat is folded into that same call. The v0.1 gold-push above
// is independent and keeps working regardless.
// ═════════════════════════════════════════════════════════════════════════

const PROC_PREFIX = `${LOG_PREFIX} proc:`;
const POLL_MS = 10_000;

let processorStarted = false;
let packIndexCache = null;   // [{ pack, index }], cached for the processor's run
const purchaseQueue = [];    // FIFO of pending purchase refs ({id, created_at}) awaiting processing
const seenPurchaseIds = new Set(); // ids currently queued or in flight; released when the attempt concludes
let draining = false;

function plog(...args)   { console.log(PROC_PREFIX, ...args); }
function pdebug(...args) { console.debug(PROC_PREFIX, ...args); }
function pwarn(...args)  { console.warn(PROC_PREFIX, ...args); }

function processorConfigured() {
  return !!game.settings.get(MODULE_ID, 'processorUrl')
      && !!game.settings.get(MODULE_ID, 'webhookSecret');
}

// Re-checked on every event, not just at startup, so toggling the kill-switch
// or dropping the GM role mid-session takes effect immediately.
function processorActive() {
  return !!game.user?.isGM
      && isPf2e()
      && game.settings.get(MODULE_ID, 'processorEnabled') === true;
}

// Single choke-point for every broker call. POSTs { action, ...payload } to the
// Netlify function with the shared webhook secret, parses the JSON reply, and
// normalises failures (network error or non-2xx HTTP) to a branchable
// { ok:false, status, error } shape so callers never touch fetch/HTTP directly.
// On success it returns the parsed body verbatim (which always carries `ok`).
async function callProcessor(action, payload = {}) {
  const url = game.settings.get(MODULE_ID, 'processorUrl');
  const secret = game.settings.get(MODULE_ID, 'webhookSecret');
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': secret,
      },
      body: JSON.stringify({ action, ...payload }),
    });
  } catch (err) {
    pwarn(`${action}: network error`, err);
    return { ok: false, status: 0, error: String(err?.message || err) };
  }
  let parsed = null;
  try { parsed = await res.json(); } catch { /* non-JSON or empty body */ }
  if (!res.ok) {
    const error = parsed?.error || res.statusText;
    pwarn(`${action}: HTTP ${res.status} — ${error}`);
    return { ok: false, status: res.status, error };
  }
  return parsed ?? { ok: true };
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
  const res = await callProcessor('cancel', { purchase_id: id, new_status: status, reason });
  if (!res.ok) pwarn(`cancel failed for ${id}: ${res.error}`);
  ui.notifications?.warn(`Mirrin's Gate: purchase rejected — ${reason}`);
}

// Claim -> validate -> fulfil -> complete (or reject). Throws only when a row
// is left mid-fulfilment (`processing`) for manual recovery; the queue catches
// it and continues.
async function processPurchase(rawRow) {
  if (!processorActive()) return;
  const rawId = rawRow?.id;
  if (!rawId) return;

  // 1. Atomic claim. Exactly one client moves the row pending -> processing; the
  //    broker returns the authoritative row plus the buyer mapping in one call.
  const claimRes = await callProcessor('claim', { purchase_id: rawId });
  if (!claimRes.ok) { pwarn(`claim error for ${rawId}: ${claimRes.error}`); return; }
  if (claimRes.claimed === false) {
    pdebug(`claim failed for ${rawId} (already processed by another client)`);
    return;
  }
  const claimed = claimRes.purchase;
  if (!claimed?.id) { pwarn(`claim for ${rawId} returned no row`); return; }

  const items = Array.isArray(claimed.items) ? claimed.items : [];
  const totalCp = Number(claimed.total_cp) || 0;

  // 2. Buyer mapping — returned with the claim, no separate read. A null mapping
  //    is either "no row" (buyer_error null) or "couldn't read it" (buyer_error
  //    set — a Supabase/network error after the claim). Reject either way so the
  //    already-`processing` row never strands; keep the two reasons distinct.
  const mapping = claimRes.buyer;
  if (!mapping) {
    if (claimRes.buyer_error) pwarn(`buyer mapping read failed for ${claimed.id}: ${claimRes.buyer_error}`);
    const reason = claimRes.buyer_error ? 'could not read buyer mapping' : 'buyer has no character mapping';
    await rejectPurchase(claimed.id, 'rejected_other', reason);
    return;
  }

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

  // 9. Mark completed via the broker.
  const compRes = await callProcessor('complete', { purchase_id: claimed.id });
  if (!compRes.ok) { pwarn(`complete failed for ${claimed.id}: ${compRes.error}`); throw new Error(`complete_purchase failed: ${compRes.error}`); }

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
  // The poll returns the same pending id every tick until it's claimed, so skip
  // ids already queued or in flight. drainQueue releases the id once its attempt
  // concludes, so a still-pending row is re-discovered and retried on a later
  // poll. claim_purchase remains the authoritative cross-client dedup.
  if (seenPurchaseIds.has(row.id)) return;
  seenPurchaseIds.add(row.id);
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
      } finally {
        // Release the id once the attempt concludes (any exit path). If the row
        // is still pending — transient claim error, or disabled mid-flight
        // before the claim — the next poll re-discovers and retries it. If it
        // reached a terminal/processing state it is no longer pending, so
        // list-pending won't resurface it and releasing is harmless.
        if (row?.id) seenPurchaseIds.delete(row.id);
      }
    }
  } finally {
    draining = false;
  }
}

// One poll tick: ask the broker for pending purchase ids (it folds the
// GM-presence heartbeat into the same call) and enqueue any not already queued.
// Self-gates on every required condition: GM + PF2e + kill-switch on
// (processorActive) AND Processor URL + Webhook secret set (processorConfigured).
// While any are missing we skip the tick — no broker call fires, no
// Netlify/Supabase cost, heartbeat stops. The timer itself is created
// unconditionally in startProcessor, so flipping the kill-switch on or filling
// in the URL/secret mid-session resumes polling and presence live, with no
// world reload.
async function pollPending() {
  if (!processorActive() || !processorConfigured()) return;
  const res = await callProcessor('list-pending');
  if (!res.ok) return;  // callProcessor already logged; the next tick retries
  for (const row of res.pending ?? []) enqueuePurchase(row);
}

async function startProcessor() {
  if (processorStarted) return;
  if (!game.user?.isGM || !isPf2e()) return;

  processorStarted = true;

  // One-time startup status reflecting the current settings. pollPending stays
  // silent on every tick when paused/unconfigured, so this is the only line.
  if (game.settings.get(MODULE_ID, 'processorEnabled') !== true) {
    log('proc: kill-switch off — polling idle until "Enable purchase processor" is on.');
  } else if (!processorConfigured()) {
    log('proc: disabled — set "Processor URL" and "Webhook secret" to enable.');
  } else {
    log('proc: started. Polling the broker every 10s (boot scan + heartbeat folded in).');
  }

  // The interval lives for the life of the client. pollPending self-gates and
  // does no broker call (no cost, heartbeat stops) while paused or unconfigured,
  // so enabling/configuring mid-session resumes live with no world reload. Two
  // GM tabs both polling is fine — claim_purchase dedupes the race.
  await pollPending();
  setInterval(() => {
    pollPending().catch((err) => pwarn('poll error', err));
  }, POLL_MS);
}

Hooks.once('ready', () => {
  // Separate ready hook from the gold-push one so the processor can never
  // affect v0.1 behaviour.
  startProcessor().catch((err) => pwarn('startup error', err));
});
