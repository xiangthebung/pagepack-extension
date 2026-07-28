# PagePack

PagePack is a Manifest V3 Chrome extension for saving a page as a self-contained offline reading pack. Page content and the saved library stay on the user’s device.

## Included

- One primary action in the popup: **Save page**, with the tab that is about to be saved shown above it.
- Determinate progress while a single page is saved (files fetched of files found), an honest indeterminate bar when link following is discovering pages, and a cancel button that leaves nothing behind.
- **Save as I browse** collects the starting page, pages visited in that tab, and child tabs opened from it. Before saving you review the list and untick anything you do not want; the first page is always kept.
- Advanced choices live behind an **Options** disclosure: linked-page depth (single page up to three levels), keeping page scripts, and — on Pro — the per-save page and storage ceilings.
- Captures the live page DOM, inline styles, external stylesheets, images, fonts referenced by CSS, and direct video/audio files exposed as normal URLs.
- Streams large current-page captures in small chunks to avoid Chrome's extension message-size ceiling.
- Same-site link following with a default safety cap of 250 pages per save; Pro can raise it to 500 or 1,000.
- A default 1 GiB asset budget per save, subject to available browser storage and disk space; Pro can raise it to 2 or 4 GiB.
- A Library of folders and saved pages: every row has one menu with Open, Show pages, Review missing parts, Move to, Rename, and Delete. Deleting always asks first and says what will go.
- Reordering by drag or by keyboard from the grip handle; moving between folders by drag or from the row menu.
- Search across saved titles, URLs, and the saved page text. Page text is indexed in the background so the library listing itself stays small.
- A reader with a slim bar: back to Library, the page title and site, page-to-page navigation for multi-page saves, an optional scripts switch, and the live page one click away.
- Saved pages that link to other pages in the same save get a "✓ Saved" badge in the reader; links that were not saved explain themselves and offer to open online.
- Saves that could not capture everything say so in the Library row and open a report explaining each missing part, with retry, retry all, and dismiss.
- Offline navigation fallback: when Chrome reports the network is unavailable, a request for a saved URL opens the saved copy instead.
- A freemium plan: 25 saved pages per calendar month are free; PagePack Pro removes the monthly allowance and unlocks the higher per-save ceilings.
- A free save is granted as one complete interaction: if a save starts with allowance remaining, it may include more pages than the remaining count; the next save is blocked once the allowance is exhausted.
- Subscription checkout, restore, and management through ExtensionPay and Stripe. Page content is never sent to the payment provider.

## Install locally

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked**.
4. Select this `pagepack-extension` folder.

## Development

The extension ships with no runtime dependencies; `package.json` exists only for the test suite.

```
npm install     # installs fake-indexeddb for the storage-backed tests
npm test        # runs tests/*.test.mjs
npm run visual  # serves the popup at http://127.0.0.1:41731 with a mocked chrome API
```

The visual server accepts `?plan=pro`, `?journey=1`, and `?slow=1`, plus the `#library` and `#pro` hashes, so each state can be inspected in a normal tab.

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

The extension can save direct media files exposed as normal URLs. It cannot reliably save DRM-protected video, blob-only players, adaptive HLS/DASH streams, live broadcasts, or content that requires a separate player session. Individual binary assets are limited by the selected budget: 1 GiB by default for all users, or 2/4 GiB for Pro. The overall budget is subject to available browser storage and disk space.

The current page is captured from its live DOM. Recursively crawled pages are fetched as HTML, so pages that require client-side JavaScript to render their content may be incomplete. Saved JavaScript is kept by default but can be turned off under Options; it is retained for the reader's optional scripts switch and increases the size of a save. Embedded frames are removed from saved pages.

See `STORE_LISTING.md` for ready-to-paste listing copy, permission justifications, and submission fields. See `RELEASE_CHECKLIST.md` for the remaining owner/account tasks.

### Save modes

**Save page** captures the current tab. Under **Options**, *Linked pages* extends the same save to pages linked from it on the same site, up to three levels; beyond three the per-save page cap is always reached first, so deeper settings only promise something they cannot keep.

**Save as I browse** starts a collection instead: PagePack saves the starting page, follows navigation in that tab, automatically includes child tabs opened from it, and keeps a resumable draft. Unrelated tabs stay outside it. When you come back to the popup you see what was collected, including anything that failed, and you choose which pages to keep. The result is one saved item that remembers how its pages link to each other. Collections use the same *Keep scripts* setting; linked-page depth does not apply to them.

While either is running, the toolbar icon carries a badge, so progress is visible after the popup closes.

### Reader

Opening a saved item shows a plain snapshot first, so a page that depended on the network can never stall offline reading. The bar above it carries the page title and site, page-to-page navigation for multi-page saves, a scripts switch when scripts were saved, and a button to open the live page. Turning scripts on is remembered for the rest of that reading session.
