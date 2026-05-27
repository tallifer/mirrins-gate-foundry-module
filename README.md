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
