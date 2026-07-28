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

- Store icon: `icons/icon-128.png`.
- Store screenshot: `store-assets/screenshot-save-1280x800.png`. Recommended follow-up set: Library with folders, saved-page reader, and Pro view.
- Small promotional tile: `store-assets/promo-440x280.png`.

Do not claim that every website or streaming video can be saved. Do not omit the free allowance or Pro pricing from the listing.
