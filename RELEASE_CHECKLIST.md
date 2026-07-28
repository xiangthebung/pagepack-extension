# PagePack 1.0 release checklist

## Must complete before submission

- [ ] Create and verify the Chrome Web Store developer account, including 2-Step Verification and the one-time registration fee.
- [ ] Choose the permanent publisher email carefully; Chrome does not let you change the account email later.
- [ ] Replace `[YOUR SUPPORT EMAIL]` in `PRIVACY_POLICY.md` and `TERMS_OF_SALE.md`.
- [ ] Host the privacy policy and terms/refund policy on stable public HTTPS URLs.
- [ ] Register the ExtensionPay permanent ID `pagepack` (the editable dashboard name may be `pagepack-offline-web-clipper`), connect Stripe, and configure CAD $1.99 monthly and CAD $9.99 yearly plans.
- [ ] Ensure ExtensionPay/Stripe show the PagePack developer as seller and link the hosted terms, refund policy, privacy policy, and support contact.
- [ ] Test checkout, restore/sign-in, cancellation, failed renewal, the seven-day offline grace period, and a new calendar month.
- [ ] Test a free linked-page save that exceeds the remaining allowance, confirm the complete interaction is saved, and confirm the next save is blocked.
- [ ] Confirm the library index rebuilds cleanly on upgrade from a 1.0 profile (IndexedDB version 9) and that existing saves still open.
- [x] Create an initial 1280×800 Chrome Web Store screenshot and 440×280 promotional tile.
- [ ] Complete the Developer Dashboard privacy fields using `STORE_LISTING.md` and provide detailed permission justifications.
- [x] Review the final ZIP to ensure `manifest.json` is at its root and no secrets, test data, or unrelated files are included.

## Product and business decisions

- [ ] Confirm the 25-page free allowance and CAD $1.99/month or CAD $9.99/year pricing with real users. Avoid changing limits for existing customers without notice.
- [ ] Decide whether taxes are handled by Stripe/ExtensionPay or require additional merchant-of-record support in the countries you sell to.
- [ ] Establish a support-response target, refund workflow, chargeback process, and subscription-cancellation test cadence.
- [ ] Decide whether to add privacy-respecting, opt-in crash reporting later. The 1.0 build intentionally has no analytics.
- [ ] Plan how to notify users about breaking capture limitations caused by Chrome or website changes.
- [ ] Confirm that users have the right to archive the material they save; PagePack should not be marketed as a DRM or paywall bypass.

## Recommended pre-launch test matrix

- Static article, image-heavy article, CSS from a CDN, fonts from another domain, single-page app, authenticated page, redirect, offline open, failed asset, large direct media, linked pages at one/two/three levels, free-user 250-page/1 GiB caps, Pro 500/1,000-page and 2/4 GiB settings, delete/move/rename/reorder/search, save-as-I-browse with a failed page, browser restart mid-capture, and month rollover.
- Windows, macOS, ChromeOS if available; normal and offline network conditions; light and dark source pages; keyboard-only popup and reader use, including the grip-handle reorder and every row menu; screen-reader passes over the save progress, the save report, and the collection review; 200% zoom; and reduced motion.
