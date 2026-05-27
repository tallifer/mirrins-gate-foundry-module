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
