# PagePack

PagePack is a Manifest V3 Chrome extension for saving a page as a self-contained offline reading pack. Page content and the saved library stay on the user’s device.

## Included

- One-click save from the extension popup.
- Save journey mode that captures the current page and pages visited from it, including links opened in child tabs, until the user chooses Done.
- An in-progress save can be cancelled without adding a partial pack to the library.
- Captures the live page DOM, inline styles, external stylesheets, images, fonts referenced by CSS, and direct video/audio files exposed as normal URLs.
- Streams large current-page captures in small chunks to avoid Chrome’s extension message-size ceiling.
- Recursive page saving with a depth of 0–5.
- Same-site crawling with a default safety cap of 250 pages per pack; Pro can choose 500 or 1,000 pages in Capture settings.
- A built-in reader view that stores packs in IndexedDB on the current device.
- A default 1 GiB total asset budget per pack, subject to available browser storage and disk space; Pro can choose 2 or 4 GiB in Capture settings.
- A fixed-size popup with separate Save and Library views, folder organization, and search across saved page titles, URLs, and bounded page text.
- Offline navigation fallback for saved URLs when Chrome reports that the network is unavailable.
- Saved links to other captured pages continue working inside the reader.
- Links that resolve to another page in the current pack receive a clear “✓ Saved” badge in the reader.
- Library entries can expand to show every page captured in a pack in order; links not included in a pack explain how to save them with Journey or Depth and offer an Open original action.
- Packs with skipped pages or assets show a **View** action in Library with a capture report explaining each issue and the recommended retry.
- The reader opens a script-free static snapshot first, so network-dependent page scripts cannot delay or block offline reading. When scripts were saved, the reader offers an optional “Enable scripts” action.
- A freemium plan: 25 captured pages per calendar month are free; PagePack Pro removes the monthly allowance and unlocks higher per-pack limits in Capture settings: up to 1,000 pages and 4 GiB.
- A free save is granted as one complete interaction: if a save starts with allowance remaining, its recursive pack can include more pages than the remaining count; the next save is blocked once the allowance is exhausted.
- Subscription checkout, restore, and management through ExtensionPay and Stripe. Page content is never sent to the payment provider.

## Install locally

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked**.
4. Select this `pagepack-extension` folder.

## Configure PagePack Pro before publishing

1. Create an ExtensionPay account and connect the Stripe account that will receive payments.
2. Register the ExtensionPay extension using the permanent ID `pagepack` (the dashboard may display `pagepack-offline-web-clipper` as the editable extension name).
3. Add CAD monthly and yearly plans matching the in-product copy: **CAD $1.99/month** and **CAD $9.99/year**. If you choose different pricing or a different ExtensionPay ID, update `PRICING` in `monetization.js` and the price shown in `popup.html`.
4. Complete a test checkout, cancellation, sign-in/restore, and expired-payment test in an unpacked build.
5. Replace every `[YOUR SUPPORT EMAIL]` placeholder in the policy files, publish the policies on a public HTTPS page, and add those URLs to the Chrome Web Store listing and checkout flow.

Do not publish the quota-enabled build until checkout and restore have both been tested. The Chrome Web Store does not process PagePack subscriptions.

### Where the money goes

PagePack does not hold card details or process payments itself. ExtensionPay hosts checkout and account sign-in, and routes payments to the Stripe account connected to the PagePack ExtensionPay merchant account. The configured permanent ExtensionPay ID is `pagepack`; the Pro overlay reports a setup error if that merchant account or its plans are unavailable.

## Important limits

The extension can save direct media files exposed as normal URLs. It cannot reliably save DRM-protected video, blob-only players, adaptive HLS/DASH streams, live broadcasts, or content that requires a separate player session. Individual binary assets are limited by the selected pack budget: 1 GiB by default for all users, or 2/4 GiB for Pro. The overall pack budget is subject to available browser storage and disk space.

The current page is captured from its live DOM. Recursively crawled pages are fetched as HTML, so pages that require client-side JavaScript to render their content may be incomplete. Saved JavaScript is enabled by default but can be turned off per save; it is retained for the optional “Enable scripts” reader action and increases pack size. Embedded frames are removed from saved pages.

See `STORE_LISTING.md` for ready-to-paste listing copy, permission justifications, and submission fields. See `RELEASE_CHECKLIST.md` for the remaining owner/account tasks.

### Save modes

**Save page** captures the current page. The existing **Depth** control remains available for recursive same-site packs, using a depth of 0–5. **Save as you browse** starts a separate journey collection: PagePack captures the starting page, follows navigation in that tab, automatically includes child tabs opened from it, and keeps a resumable draft until the user chooses **Done** or **Discard journey**. Unrelated tabs stay outside the journey and can be saved separately with Save page. A journey is saved as one pack and retains the navigation relationships between its pages. Journey captures use the shared Scripts setting; images and direct media are captured automatically when a site exposes them as normal URLs. Depth does not affect journeys.
