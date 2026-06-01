# Mirrin's Gate — Party Gold Sync

A Foundry VTT module that watches the PF2e Party actor's coin total and pushes it to the Mirrin's Gate marketplace webhook, so the in-world gold banner stays in sync with whatever your party is actually carrying.

## Requirements

- Foundry VTT v13 (build 351 or newer).
- The Pathfinder Second Edition (PF2e) system. The module does nothing in worlds running other systems and will log a single console warning if loaded into one.
- You must be running the world as the GM. The module's hooks are GM-only — if the GM isn't logged in, nothing syncs.

## Installation

You have two install paths. The manifest URL path is the standard one; the manual path is the fastest if you haven't cut a release of this repo yet.

### Manifest URL (standard)

1. Open The Forge and go to your **Bazaar**.
2. Click **My Foundry** → **Install Module via Manifest URL**.
3. Paste this URL:

   ```
   https://raw.githubusercontent.com/tallifer/mirrinsgate/main/foundry-module/module.json
   ```

4. Confirm. The Forge will fetch the manifest and download the module's release zip.

Note: this path requires a GitHub release named `foundry-module-v0.1.0` with `mirrins-gate-gold.zip` attached, matching the `download` URL in `module.json`. If no such release exists yet, use the manual install below.

### Manual install

If you're installing before the first release is cut (or you'd rather not rely on a release archive at all):

1. Download or clone this repository.
2. Copy the entire `foundry-module/` folder into your Foundry data directory at `Data/modules/`, renaming the copy to `mirrins-gate-gold/`. The result should be a folder at `Data/modules/mirrins-gate-gold/` containing `module.json`, `scripts/`, and this README.
3. Restart Foundry. The module will now appear in your module list.

On The Forge, manual install means uploading the folder via The Forge's Assets Library → My Foundry → Configure Module Folders, or via the Foundry desktop client pointed at your Forge data.

## Activation

In your world, open **Game Settings** → **Manage Modules**, find **Mirrin's Gate — Party Gold Sync**, tick it, and **Save Module Settings**. Foundry will reload the world.

If your world is not running PF2e, the module loads but does nothing. You'll see a single line in the browser console — `[mirrins-gate-gold] Inactive: this module requires the PF2e system` — and no further activity.

## Configuration

Open **Game Settings** → **Configure Settings** → **Module Settings**, scroll to **Mirrin's Gate — Party Gold Sync**, and fill in the three fields:

**Webhook URL.** The full URL of the deployed Supabase Edge Function. It looks like `https://<your-project>.supabase.co/functions/v1/foundry-gold-webhook`. You can find your project ref in the Supabase dashboard under Project Settings.

**Webhook secret.** The shared secret. It must match the `FOUNDRY_WEBHOOK_SECRET` environment variable set on the Supabase function. Treat this value as sensitive — anyone who knows the URL and the secret can post any gold figure they like to your marketplace. Foundry has no masked-input UI for settings, so the value will be visible in the settings dialog; do not give players GM access while it's populated.

**Party actor id.** Leave this blank if your world has exactly one Party actor — the module will auto-detect it. Otherwise, paste the actor id. To find it, open a browser console (F12) in the Foundry tab and run:

```javascript
game.actors.filter(a => a.type === 'party').map(a => ({ name: a.name, id: a.id }))
```

That prints the name and id of every Party actor in the world. Copy the id of the one Mirrin's Gate should track and paste it into the field.

Save the settings. Foundry does not need to reload.

## Verification

Two ways to confirm everything is wired up correctly.

**Test ping.** Below the three fields you'll see a **Test webhook** entry with a **Send test ping** button. Click it; the module sends the current party gold to the webhook and reports the HTTP result as a UI notification. A green "test successful" toast means the URL, secret, and actor lookup all worked.

**End-to-end.** Open the configured Party actor's sheet, adjust the coin total by 1 cp (or drag a coin onto or off the party), and watch the Mirrin's Gate marketplace tab in your browser. The gold banner should update within a couple of seconds.

## Troubleshooting

All module messages are prefixed `[mirrins-gate-gold]` in the browser console (F12). When something looks wrong, open the console first.

- **Nothing happens when I open the world.** Confirm the GM user is logged in (the module is GM-only). Confirm the world is running PF2e. Check the console for `[mirrins-gate-gold] Ready` on startup.
- **`Configured party actor id "..." not found in world.`** The id in the setting doesn't match any actor. Re-run the console snippet above and paste the correct id, or clear the field if you only have one Party actor.
- **`Multiple party actors found; set "Party actor id" to disambiguate.`** Auto-detect won't pick between them. Fill in the id of the specific Party actor Mirrin's Gate should follow.
- **`Webhook URL or secret not configured; skipping send.`** One of the two fields is blank.
- **`Webhook returned 401`** (also surfaces as a UI toast). The secret in Foundry doesn't match `FOUNDRY_WEBHOOK_SECRET` on Supabase. Update one to match the other.
- **`Webhook returned 400`.** Almost always means the gold value computed to something the backend rejected (e.g. negative). Capture the console log and check the configured actor's coins manually.
- **`Network error pushing gold`.** Foundry couldn't reach the webhook URL. Verify the URL is correct and that Supabase function is deployed.
- **UI notifications appear at most once every 30 seconds.** This is intentional. The full detail of every failure is still in the console.
- **Marketplace doesn't update even though the test ping succeeded.** That points at the marketplace's Realtime subscription, not this module — your gold reached Supabase. Check the marketplace tab's network console for the `party_state` subscription.

The module only runs in the GM's browser. If you close the Foundry tab, gold updates stop until you reopen it.

## Purchase processor (v0.2+)

On GM clients the module can also **process website purchases end to end**. When
a player checks out on the marketplace, a `pending` purchase row is created in
Supabase. With the processor running, the GM's Foundry client:

1. **Claims** the purchase atomically (`pending → processing`) so that if two GM
   clients are open at once, exactly one of them fulfils it.
2. **Validates** the buyer (their `user_characters` mapping → a character actor
   in this world), the party actor, and that the party can afford the total.
3. **Fulfils** it: deducts the cost from the party actor's coins and grants the
   items to the buyer's character. Catalogue items are matched to your
   compendiums by name (case-insensitive); items flagged homebrew get a
   barebones `equipment` entry instead.
4. **Completes** the row (`→ completed`) — or **rejects** it, restoring stock.

The buyer sees the result live in their "Recent purchases" panel; the GM sees a
notification toast.

### Settings

Three new fields appear under **Module Settings → Mirrin's Gate**, alongside the
gold-sync fields:

- **Supabase URL** — your project URL, e.g. `https://<project>.supabase.co`.
- **Supabase service-role key** — from Supabase → Project Settings → API → the
  **service_role** key. **This is sensitive**: it bypasses all row security.
  Anyone with GM access to this world can read it from the settings dialog, so
  do not give players GM while it is populated.
- **Enable purchase processor** — a master kill-switch (on by default). Turn it
  off to pause processing without clearing the URL/key. It does not affect
  gold-sync.

If the URL or key is blank, or the kill-switch is off, the processor stays
silent and the v0.1 gold-sync keeps working. You'll see one line on startup:
`[mirrins-gate-gold] proc: disabled — set "Supabase URL" and "Supabase
service-role key" to enable.`

### Single-shared-world assumption

This is built for **one shared Foundry world** that whoever is DMing opens. The
processor runs on whichever client is the GM (`game.user.isGM`), and its
settings are **world-scoped**, so they persist as the DM seat rotates between
players. If you open a *different* world (a test world, a one-shot), these
settings do not follow it and the processor won't run there until configured
again.

### Recovering a stuck `processing` row

If a GM client crashes (or errors) mid-fulfilment, a row can be left as
`processing`. The boot scan deliberately ignores `processing` rows (retrying
would risk double-spending), so it shows up as a stuck row in the Supabase Table
Editor. Recover it from the SQL editor:

```sql
select public.cancel_purchase('<purchase-id>', 'rejected_other', 'stuck processing recovery');
```

That restores stock and marks the row rejected. If the crash happened *after*
gold was deducted but before items were granted, `cancel_purchase` does **not**
refund gold — check the party's coin total in Foundry and re-add it manually.

### Failure modes (what you'll see in the GM notification feed)

All processor logs are prefixed `[mirrins-gate-gold] proc:` in the console (F12).

- **CDN blocked.** The processor loads the Supabase library from `esm.sh` on
  demand. If your host (e.g. The Forge) blocks it, you'll see `proc: failed to
  load supabase-js …; processor disabled for this session` — gold-sync still
  works; purchases just won't process until the CDN is reachable.
- **Item not in a compendium.** `purchase rejected — item '<name>' not found in
  any compendium`. The `foundry_name` in the catalogue doesn't match any
  compendium item. Fix the name in `marketplace.json` (and re-seed as admin), or
  flag the item homebrew.
- **Buyer not mapped / actor missing.** `purchase rejected — buyer has no
  character mapping` or `… buyer's character actor not found in this world`.
  Check the buyer's `user_characters.actor_id` points at an actor in this world.
- **Party actor missing.** `purchase rejected — party actor not found`. Set the
  **Party actor id** field (same one gold-sync uses).
- **Insufficient funds.** `purchase rejected — party has X cp, purchase costs Y
  cp`. The party stash can't cover it; nothing is deducted.

A rejected purchase always restores the stock it reserved, so the player can buy
again once the underlying problem is fixed.
