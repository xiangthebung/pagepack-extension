# Chrome Web Store listing copy

## Name

PagePack — Offline Web Clipper

## Summary

Save complete web pages to a private, on-device library for reliable offline reading.

## Category

Productivity

## Single purpose

PagePack lets a user intentionally save a web page, and optionally the same-site pages linked from it or visited after it, into a private on-device library, then read and navigate those saved pages offline.

## Detailed description

Save the page you are viewing—with its layout, images, styles, fonts, and direct media exposed as normal URLs—then open it later from PagePack’s private on-device library.

PagePack includes:

- One-click capture of the page you are viewing, with live progress and a cancel button.
- Save as I browse: PagePack collects the starting page, pages visited in that tab, and child tabs opened from it, then lets you review and untick pages before saving them as one item.
- Optional same-site link following, up to three levels deep.
- Folders, full-text search across saved page text, move and reorder by pointer or keyboard, and offline navigation between saved pages.
- A reader with page-to-page navigation, the site’s live page one click away, and a clear “✓ Saved” badge on links that open offline.
- Partial saves are reported plainly: each item shows what is missing and offers a retry.
- A sandboxed reader that blocks saved pages from accessing your cookies, extension data, or the network.
- A plain snapshot opens first so nothing can stall offline reading; saved scripts can be switched on from the reader when a page needs them.
- 25 captured pages free each calendar month. Existing saved pages remain readable and manageable without payment.
- PagePack Pro for unlimited page saves plus optional higher per-pack limits at CAD $1.99/month or CAD $9.99/year. Pro users can raise the per-save ceiling to 1,000 pages or 4 GiB under Options.

Your saved pages stay on this device. PagePack does not sell browsing data, run ads, or send saved-page content to the developer or payment provider.

Some pages cannot be captured completely, including DRM video, live streams, blob-only media, logged-in resources that reject extension requests, and pages whose content requires a live server session.

## Permission justifications

- **scripting**: Starts the capture helper in the chosen tab only when the user chooses Save or starts collecting; PagePack does not keep a content script running on every page when capture is inactive.
- **storage / unlimitedStorage**: Stores the offline library locally. Page packs can be much larger than the default extension storage allowance.
- **host access to all sites**: Fetches the styles, images, fonts, direct media, and same-site linked pages explicitly requested by the user. Assets can be hosted on domains different from the page itself.
- **webNavigation**: Watches completed navigation only while a user-requested collection is active, and checks the local URL index when a normal navigation fails offline. Those relationships are stored locally with the collection; navigation data is not transmitted.

## Privacy disclosures for the Developer Dashboard

PagePack handles **website content** and **web history/browsing activity** solely to perform the user-requested capture, saved-link navigation, and offline fallback. It handles a payment account email and subscription state only when a user chooses PagePack Pro. Saved content is stored locally and is not transmitted. Subscription status is exchanged with ExtensionPay; checkout information is handled by ExtensionPay and Stripe.

Certify that the data is not sold, is not used for advertising or credit decisions, and is used only for the extension’s single purpose. Link the publicly hosted `PRIVACY_POLICY.md` content in the dashboard.

## Required visual assets

All produced from `dist/` — the directory `npm run zip` packages — by:

```
npm run build && node scripts/store-shots.mjs
```

The script loads the built extension into a real Chromium, uses it, photographs the result, and measures every file it writes from the PNG header before exiting; a file that is off by a pixel fails the run rather than the upload. It needs Playwright, which is not a dependency of the extension: `npm install --no-save playwright` once.

- Store icon: `dist/icons/icon-128.png` (`icons/icon-128.png` in the source tree).
- Screenshots, all exactly 1280×800:
  - `store-assets/01-save-1280x800.png` — a capture in flight: the popup's progress card reporting a real file count against a page whose assets are still arriving, with the cancel button in view.
  - `store-assets/02-library-1280x800.png` — the library at the top level, a folder with the pages of one save listed inside it, and a full-text search matching three items by their captured text rather than their titles.
  - `store-assets/03-reader-1280x800.png` — the saved-page reader, with page-to-page navigation and the “✓ Saved” badge on links that open offline.
  - `store-assets/04-offline-1280x800.png` — Chromium with its network switched off: the popup declining to start a save, beside a saved address that failed to load and was opened from disk instead.
- Small promotional tile: `store-assets/promo-440x280.png`, exactly 440×280. `store-assets/promo-440x280.svg` is the hand-drawn original the tile follows; keep the two in step if either changes.

Every pixel of PagePack in those screenshots was rendered by the shipped build, driven through its own interface. The pages being saved are an invented publication served from a local server for the run; it names, depicts and imitates nobody, says so in its own masthead, and the composition repeats it in the corner of every shot.

Do not claim that every website or streaming video can be saved. Do not omit the free allowance or Pro pricing from the listing.

## Claims to avoid

Everything below is something the code cannot support. Keeping it out of the listing is not modesty; each one is a refund request or a rejection waiting to happen.

- **Do not claim a saved page with scripts enabled can make no outbound request at all.** The sandbox CSP blocks the ways a page fetches things — `connect-src 'none'` covers fetch, XHR, WebSocket, EventSource, `sendBeacon` and worker requests, remote images, scripts, stylesheets and fonts are refused, and `form-action 'none'` blocks form submission — but a saved script can still navigate the reader's own frame, by assigning to `location`, and no CSP directive prevents that. The verified claim is the narrower one already in the description: the sandboxed reader blocks saved pages from reaching your cookies, extension data or the network. Say that, not "cannot reach the internet".
