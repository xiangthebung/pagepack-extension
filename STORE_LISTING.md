# Chrome Web Store listing copy

## Name

PagePack — Offline Web Clipper

## Summary

Save complete web pages to a private, on-device library for reliable offline reading.

## Category

Productivity

## Single purpose

PagePack lets a user intentionally capture a web page and selected same-site linked pages into a private, on-device library, then read and navigate those saved pages when offline.

## Detailed description

Save the page you are viewing—with its layout, images, styles, fonts, and direct media exposed as normal URLs—then open it later from PagePack’s private on-device library.

PagePack includes:

- One-click capture of the live page you choose.
- Save-as-you-browse journeys that collect the starting page, pages visited in that tab, and child tabs opened from it until you choose Done.
- Optional same-site recursive saving from depth 0–5.
- Folder organization, search, drag-and-drop ordering, and offline navigation between captured pages.
- Saved links receive a clear “✓ Saved” badge in the reader so users can see which navigation targets are available offline.
- Saved packs can expand to show every captured page in order, and the reader clearly explains when a linked page has not been captured yet.
- A sandboxed reader that blocks saved pages from accessing your cookies, extension data, or the network.
- Saved-site scripts enabled by default for more faithful offline rendering, with an opt-out toggle.
- 25 captured pages free each calendar month. Existing saved pages remain readable and manageable without payment.
- PagePack Pro for unlimited page saves plus optional higher per-pack limits at CAD $1.99/month or CAD $9.99/year. Pro users can choose up to 1,000 pages or 4 GiB per pack in Capture settings.

Your saved pages stay on this device. PagePack does not sell browsing data, run ads, or send saved-page content to the developer or payment provider.

Some pages cannot be captured completely, including DRM video, live streams, blob-only media, logged-in resources that reject extension requests, and pages whose content requires a live server session.

## Permission justifications

- **scripting**: Starts the capture helper in the chosen tab only when the user clicks Save or starts a journey; PagePack does not keep a content script running on every page when capture is inactive.
- **storage / unlimitedStorage**: Stores the offline library locally. Page packs can be much larger than the default extension storage allowance.
- **host access to all sites**: Fetches the styles, images, fonts, direct media, and same-site linked pages explicitly requested by the user. Assets can be hosted on domains different from the page itself.
- **webNavigation**: Watches completed navigation only while a user-requested journey is active, and checks the local URL index when a normal navigation fails offline. Journey relationships are stored with that journey locally; navigation data is not transmitted.

## Privacy disclosures for the Developer Dashboard

PagePack handles **website content** and **web history/browsing activity** solely to perform the user-requested capture, saved-link navigation, and offline fallback. It handles a payment account email and subscription state only when a user chooses PagePack Pro. Saved content is stored locally and is not transmitted. Subscription status is exchanged with ExtensionPay; checkout information is handled by ExtensionPay and Stripe.

Certify that the data is not sold, is not used for advertising or credit decisions, and is used only for the extension’s single purpose. Link the publicly hosted `PRIVACY_POLICY.md` content in the dashboard.

## Required visual assets

- Store icon: `icons/icon-128.png`.
- Store screenshot: `store-assets/screenshot-save-1280x800.png`. Recommended follow-up set: Library with folders, saved-page reader, and Pro view.
- Small promotional tile: `store-assets/promo-440x280.png`.

Do not claim that every website or streaming video can be saved. Do not omit the free allowance or Pro pricing from the listing.
