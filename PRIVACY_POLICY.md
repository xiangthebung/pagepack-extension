# PagePack Privacy Policy

Effective: September 2, 2026

PagePack saves web pages for offline reading. Privacy is part of that purpose: the pages you save and your PagePack library remain on your device.

## Data PagePack handles

When you click **Save page**, press its keyboard shortcut, choose **Save link with PagePack** on a link, or save the tabs in a window, PagePack accesses the page’s URL, title, visible document content, styles, images, fonts, direct media, site icon, and linked same-site pages you asked it to capture. With linked pages on, PagePack first reads the links on the current page and fetches the linked pages to count them, and shows you the list before anything is saved. When you start **Save as I browse**, PagePack accesses the pages you visit in the starting tab and child tabs opened from it until you save or discard that collection. PagePack stores that material locally in your browser’s IndexedDB storage, together with a small picture of the tab as it was when saved from the popup, the shortcut or a batch. PagePack also stores local preferences, folders, monthly page-allowance usage, capture status, and — for each save — which pages you have opened and how far down each one you were, so the reader can take you back there.

To save a page completely, PagePack requests that page’s images, stylesheets, fonts, and linked pages using your browser’s existing session for that site, exactly as the browser would if you opened them yourself. This is what allows a page you are signed in to to be saved correctly. Those requests go to the site being saved and to no one else, and they stop when the save finishes.

PagePack does not sell this data, use it for advertising, send it to the PagePack developer, or use it to build a browsing history. Page access exists only to provide saving, collecting as you browse, offline reading, saved-link navigation, and offline fallback—the extension’s disclosed user-facing features.

## PagePack Pro and payments

If you choose to upgrade or restore PagePack Pro, the extension contacts ExtensionPay to create an anonymous installation/license identifier and to check whether the associated subscription is active. ExtensionPay and Stripe handle checkout, account sign-in, payment details, taxes, and subscription management on their own pages. PagePack does not receive or store card details, and it never sends saved-page content or browsing history to ExtensionPay or Stripe.

The payment-status cache stored by the extension may include whether Pro is active, the account email returned by ExtensionPay, plan information, and the last status-check time. It is used only to unlock Pro features and provide a short offline grace period.

## Retention and deletion

Saved pages, their pictures and their reading positions remain until you delete them from the PagePack library or uninstall the extension; deleting a save removes all three. An export you write with **Export as HTML** is an ordinary file on your device, outside PagePack’s control. Local settings and payment-status data remain until the extension is uninstalled or browser storage is cleared. Data held by ExtensionPay or Stripe is governed by their respective policies and retention requirements.

## Security

Saved pages open in an isolated reader with no access to extension APIs, browser cookies, or site storage, and no access to the network. Reading a saved page makes no network request of any kind: everything shown comes from the copy on your device.

Three things hold that up. Anything in a page that would load from the network is rewritten during the save to point at the saved copy instead. Anything that would navigate away — including a page’s own refresh directive — is removed when the page is saved. And the reader runs saved pages under a policy that denies every category of network request by default, so anything the first two missed is refused by the browser rather than fetched. Following a link in a saved page moves to another saved page, or asks whether you want to open the live one; it never opens the live page on its own.

Scripts saved with a page do not run when you open it. The reader shows a plain snapshot first, and you can turn the saved scripts on for that reading session if you want them. Saved scripts get an isolated, in-memory replacement for site storage and cannot reach the network either.

## Limited Use

PagePack’s use of information received from Chrome APIs complies with the Chrome Web Store User Data Policy, including the Limited Use requirements. PagePack uses website content and browsing activity only to provide and improve the user-facing offline-saving features described above.

## Changes

Material changes to this policy or PagePack’s data practices will be disclosed before they take effect. The effective date above will be updated.

## Contact

Questions, deletion requests concerning payment-account data, or privacy concerns: **xiangli3625@gmail.com**.
