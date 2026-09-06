# PagePack

PagePack is a Manifest V3 Chrome extension for saving a page — and the pages it links to — as a self-contained offline reading pack. Page content and the saved library stay on the user’s device.

## The offline guarantee

Opening a saved page makes no network request. That is the product, so it is
checked rather than asserted, and it is worth knowing how it is held up, because
the three parts are not interchangeable.

1. **Capture rewrites what loads.** Every attribute and CSS construct that fetches
   something is pointed at the copy in the pack. `url-surface.js` holds the
   enumeration — `srcset`, `poster`, SVG `href` and `xlink:href`, `image-set()`,
   `@import`, the obsolete `background` attribute, and the rest.
2. **Capture removes what navigates.** Frames, `<object>`, `<embed>`, a page's own
   `<base>`, and `<meta http-equiv="refresh">`. The refresh is the reason this
   step has to exist separately: everything else here loads a subresource, and a
   subresource can be refused by a policy, but a refresh *navigates*, and no
   content-security-policy directive in any shipping browser stops a sandboxed
   frame navigating itself. If one survived the save, opening it would walk you
   onto the live site.
3. **The reader refuses the rest.** Saved pages render in a sandboxed frame under
   `default-src 'none'` with narrow allowances for content already in the pack, so
   anything the first two steps missed is refused by the browser instead of
   fetched. It fails closed: a directive nobody thought of is denied, not allowed.

Verified two ways, both in `npm test`:

| Check | What it proves |
| --- | --- |
| `tests/offline-guarantee.test.mjs` | A fixture carrying every URL-bearing construct comes out of capture with nothing addressable left, audited by a scanner that does not share its expressions with the rewriters. |
| `tests/offline-network.test.mjs` | A real Chromium renders a real pack through the real sandbox under the policy read out of `manifest.json`, and makes zero requests — from both capture paths. It also asserts the policy does *not* stop a meta refresh, so the reason step 2 exists cannot quietly stop being true. |
| `tests/extension-loads.test.mjs` | The built `dist/` loads in Chrome, saves a live page through the extension's own message API, and reads it back with the network watched. It also drives the pre-flight, a batch of tabs, an update in place and a link saved from the menu. |
| `tests/big-pack.test.mjs` | A pack of sixty half-megabyte images — 30 MB of image data, 40 MB as stored — opens in the real reader within a budget, every image decoded from a `blob:` URL minted inside the sandbox, with no request leaving the extension. |

Breaking any one of the three layers is caught. Breaking the strip in only one of
capture or the reader is not caught by the browser test, because the other layer
still holds — that is the intended shape, and it is why the unit test exists too.

## Included

- One primary action in the popup: **Save page**, with the tab that is about to be saved shown above it, and under it what the press will cost: "Uses 1 of 21 free pages left this month".
- **A pre-flight for linked saves.** With *Linked pages* on, the button reads **Save with linked pages…** and finds the same-site links first — cheaply, from the live page, fetching only what deeper levels need — then shows "37 pages found · ~12 MB estimated" in a sheet where you untick what you do not want. Only then does the save start, and it knows its total: the bar is honest and the card reads "12 of 37 pages · 8.4 MB" while the toolbar badge counts pages as they land.
- **Already saved?** If the page in front is in the library the popup says so — "Saved 2 h ago · Open / Save again" — and every save has an **Update** in its ⋯ menu that captures it again in place, keeping its folder, its position and its id.
- **Save all tabs in this window**, from the popup: every http(s) tab in the window is listed, tabs already in the library start unticked, and each becomes its own save under one progress card.
- **Ctrl+Shift+S** (⌘⇧S on a Mac) saves the current page with the remembered options, and **Save link with PagePack** on any link's context menu saves the page behind it without opening it. Neither has a popup to report to, so a refusal shows as a red "!" on the toolbar icon for a few seconds with the reason in its tooltip.
- Determinate progress while a single page is saved (files fetched of files found), an honest indeterminate bar when link following is discovering pages without a pre-flight, and a cancel button that leaves nothing behind (a cancelled batch keeps the tabs already written, and says how many).
- **Save as I browse** collects the starting page, pages visited in that tab, and child tabs opened from it. Before saving you review the list and untick anything you do not want; the first page is always kept.
- Advanced choices live behind an **Options** disclosure: linked-page depth (single page up to three levels), keeping page scripts, and — on Pro — the per-save page and storage ceilings.
- Captures the live page DOM, inline styles, external stylesheets (including what their `@import` and `url()` rules pull in), images, responsive `srcset` candidates, SVG images, CSS-referenced fonts, video captions, and direct video/audio files exposed as normal URLs.
- Streams large current-page captures in small chunks to avoid Chrome's extension message-size ceiling.
- Moving or reordering a save writes only the save that moved: it takes a sort value between its new neighbours, so a library of large saves is not copied to change one field on one row.
- Same-site link following with a default safety cap of 250 pages per save; Pro can raise it to 500 or 1,000. At most 100 links are followed from any one page, and a page where that cut in is listed in the save's report.
- A default 1 GiB asset budget per save, subject to available browser storage and disk space; Pro can raise it to 2 or 4 GiB. Reaching either ceiling stops the save and keeps the pages already captured, rather than discarding the run.
- A Library of folders and saved pages: every row carries the site's icon, a blue dot until it has been opened, and one menu with Open, Show pages, Review missing parts, Update, Export as HTML, Move to, Rename, and Delete. Deleting always asks first and says what will go.
- Opened in a tab — from the reader's Library button — the library is a full-width page: a picture of each page as it was saved (taken through `activeTab` of the tab you pressed Save on, so a page saved from a link or a background tab shows its site icon instead), a storage line ("Library: 1.2 GB of ~58 GB available", from the browser's own estimate), and sort and filter controls (your order, newest, oldest, title, largest; all, unread, multi-page, collections, missing parts).
- **Export as HTML** writes one self-contained file per save: a single page with every image, style and font inlined and its scripts removed, or — for a multi-page save — one file that carries every page and a list to move between them, with links between saved pages working from the file.
- Reordering by drag or by keyboard from the grip handle; moving between folders by drag or from the row menu.
- Search across saved titles, URLs, and saved page text. Page text is indexed in the background so the library listing itself stays small; the index holds the first 4,000 characters of each page, so a match late in a long article will not be found.
- A reader with a slim bar: back to Library, the page title and site, page-to-page navigation for multi-page saves, an optional scripts switch, and the live page one click away. The tab is named after the page and carries the site's icon; a collapsible sidebar lists the pages of the save ("In this save") with the ones already read marked; ← and → move between pages; and each page resumes where you left it — a bare link to a save reopens on the page you were reading.
- Image-heavy pages open. The reader hands the sandbox the page's markup with resources still tokenised and the resources as Blobs, resolves the tokens after parsing against `blob:` URLs minted inside the sandbox, and gives the render a deadline that grows with the page. A 30 MB single page used to save and then refuse to open; `tests/big-pack.test.mjs` opens one on every run.
- Saved pages that link to other pages in the same save get a "✓ Saved" badge in the reader; links that were not saved explain themselves and offer to open online.
- Saves that could not capture everything say so in the Library row and open a report explaining each missing part, with retry, retry all, and dismiss.
- Offline navigation fallback: when Chrome reports the network is unavailable, a request for a saved URL opens the saved copy instead.
- A freemium plan: 25 saved pages per calendar month are free; PagePack Pro removes the monthly allowance and unlocks the higher per-save ceilings. The popup counts it in pages — "21 pages left this month" — because that is what a save spends: a four-page save takes four. An update counts its pages again.
- A free save is granted as one complete interaction: if a save starts with allowance remaining, it may include more pages than the remaining count; the next save is blocked once the allowance is exhausted. The pre-flight sheet says which of those it is before you confirm.
- Subscription checkout, restore, and management through ExtensionPay and Stripe. Page content is never sent to the payment provider.

## Install locally

```
npm run build
```

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked**.
4. Select the `dist/` folder.

Load `dist/`, not the repository root. The extension is plain ES modules with no
dependencies, so the build is only a copy — but it is the same one-line command
and the same `dist/` target as every other extension in this workspace, and the
store artifact is packaged from that exact output so it cannot fall behind the
source the way a hand-assembled zip does.

The copy is an explicit allowlist in `scripts/build.mjs`, so tests, docs and
store assets are never shipped. The build then reads `dist/` back and resolves
every reference the manifest, HTML and JS modules make; anything missing fails
the build rather than producing a popup that silently does nothing.

## Development

The extension ships with no runtime dependencies; `package.json` exists only for the test suite and the build.

```
npm install                        # fake-indexeddb and Playwright
npx playwright install chromium    # once; the browser tests need a real Chromium
npm run build   # assemble dist/
npm run watch   # reassemble on change
npm test        # runs tests/*.test.mjs
npm run verify  # build, then tests — in that order, see below
npm run zip     # build, then artifacts/pagepack-<version>.zip (verified)
npm run visual  # serves the popup at http://127.0.0.1:41731 with a mocked chrome API
```

`verify` builds before it tests, not after. `tests/extension-loads.test.mjs` loads
`dist/` as a real unpacked extension, so testing first would check yesterday's
build and pass.

Three of the tests drive a real browser and take about half a minute between them.
They use `channel: "chromium"`, which is required: extensions do not load in the
headless shell Playwright uses by default, and the service worker never registers.

The visual server accepts `?plan=pro`, `?journey=1`, and `?slow=1`, plus the `#library` and `#pro` hashes, so each state can be inspected in a normal tab.

One thing worth knowing before editing the reader or the popup: `viewer.js`,
`popup.js` and `content.js` cannot be imported by a Node test, because they need
the extension APIs to load. Nothing checks their syntax except a browser. A
backtick inside a comment inside a template literal in `viewer.js` once broke the
reader completely while the whole suite stayed green;
`tests/extension-loads.test.mjs` exists to catch that class of mistake.

## Configure PagePack Pro before publishing

0. The keyboard shortcut is a suggestion Chrome may decline if another extension already holds Ctrl+Shift+S; the user can rebind it at `chrome://extensions/shortcuts`. The listing should say so.
1. Create an ExtensionPay account and connect the Stripe account that will receive payments.
2. Register the ExtensionPay extension using the permanent ID `pagepack` (the dashboard may display `pagepack-offline-web-clipper` as the editable extension name).
3. Add a monthly and a yearly plan. **The prices live only in that dashboard.** The popup reads them from `/api/v2/current-plans` through `pricing.js` and renders whatever it is told, so changing a price needs no code change here — and there is nothing in this repository to keep in sync. If the provider cannot be reached, the card says the price is shown at checkout rather than guessing.
   Two places still state a price in prose and do need updating by hand if you change one: `TERMS_OF_SALE.md` and `STORE_LISTING.md`.
4. Complete a test checkout, cancellation, sign-in/restore, and expired-payment test in an unpacked build. Check that the Pro card shows the amounts you configured, not a fallback sentence — a fallback means the plans request failed.
5. The policies in `PRIVACY_POLICY.md` and `TERMS_OF_SALE.md` are published at `/legal/pagepack/privacy` and `/legal/pagepack/terms` on the developer's site; put those URLs in the Chrome Web Store listing. Edit the files here, not the published copies: the site keeps a copy and its test suite diffs the two.

Do not publish the quota-enabled build until checkout and restore have both been tested. The Chrome Web Store does not process PagePack subscriptions.

### Where the money goes

PagePack does not hold card details or process payments itself. ExtensionPay hosts checkout and account sign-in, and routes payments to the Stripe account connected to the PagePack ExtensionPay merchant account. The configured permanent ExtensionPay ID is `pagepack`; the Pro overlay reports a setup error if that merchant account or its plans are unavailable.

## Important limits

The extension can save direct media files exposed as normal URLs. It cannot reliably save DRM-protected video, blob-only players, adaptive HLS/DASH streams, live broadcasts, or content that requires a separate player session. A single asset larger than 128 MiB is skipped and listed in the save's report; the whole save is additionally bounded by the per-save budget, which is subject to available browser storage and disk space.

The current page is captured from its live DOM. Recursively crawled pages are fetched as HTML, so pages that require client-side JavaScript to render their content may be incomplete. Saved JavaScript is kept by default but can be turned off under Options; it is retained for the reader's optional scripts switch and increases the size of a save.

Some things are removed rather than saved, because the reader could not show them
and keeping them would mean keeping a live address in the pack:

- Embedded frames — `<iframe>`, `<frame>` — and their content.
- `<object>` and `<embed>`. The reader denies plugin content outright, so saved
  bytes for them could never render.
- `<noscript>` content, which would otherwise display whenever saved scripts are
  off, tracking pixels included.
- A page's own `<base>` and any `<meta http-equiv="refresh">`.
- SVG `<use>` references into another file. Browsers refuse a cross-document
  `<use>` target, so the sprite is blank either way; a same-document `#id`
  reference is kept and works.

Lazy-loading attributes such as `data-src` are left as they are. Nothing loads
them on its own, they frequently hold values that are not URLs at all, and if a
saved script promotes one to a real `src` the reader refuses the result — which
is measured in `tests/offline-network.test.mjs` rather than assumed.

Link following treats a site as its registrable domain, using a curated subset of
the Public Suffix List in `background.js`. That subset matters: without the
hosting-platform entries, every site on `github.io` counted as one site and a save
would follow links into strangers' pages. If a site is ever misjudged, add its
suffix there.

See `STORE_LISTING.md` for ready-to-paste listing copy, permission justifications, and submission fields. See `RELEASE_CHECKLIST.md` for the remaining owner/account tasks.

### Save modes

**Save page** captures the current tab. Under **Options**, *Linked pages* extends the same save to pages linked from it on the same site, up to three levels; beyond three the per-save page cap is always reached first, so deeper settings only promise something they cannot keep. A linked save always goes through the pre-flight sheet first: the first level of links is read out of the live page, deeper levels are fetched as HTML only, and the pages fetched for the count are reused by the save so nothing is downloaded twice. The size shown is an estimate and says so; it is built from what the live page weighed when it loaded and errs low.

**Save all tabs in this window** and the **Ctrl+Shift+S** shortcut save single pages with the remembered *Keep scripts* and *Save to* settings; the shortcut ignores *Linked pages*, because a shortcut has nowhere to show a sheet. **Save link with PagePack** on a link's context menu fetches the page behind the link without opening it, so it is captured the way a followed link is.

**Save as I browse** starts a collection instead: PagePack saves the starting page, follows navigation in that tab, automatically includes child tabs opened from it, and keeps a resumable draft. Unrelated tabs stay outside it. When you come back to the popup you see what was collected, including anything that failed, and you choose which pages to keep. The result is one saved item that remembers how its pages link to each other. Collections use the same *Keep scripts* setting; linked-page depth does not apply to them.

While either is running, the toolbar icon carries a badge, so progress is visible
after the popup closes. Colour tells the two modes apart, because at badge size a
colour is legible at a glance and a glyph is not:

| | Badge | Meaning |
| --- | --- | --- |
| **Save page**, single page | Blue dot | Working. There is no page count worth showing. |
| **Save page**, linked pages, or a batch of tabs | Blue number | Pages saved so far. It only goes up. |
| A refusal with no popup open | Red "!" for six seconds | A shortcut or context-menu save could not start; the reason is the icon's tooltip. |
| **Save as I browse** | Red number | Pages collected so far. |

The number on a link-following save is what distinguishes a save that is working
from one that is stuck, which a static dot cannot. It counts pages already saved,
never work remaining, and caps at `99+`.

### Reader

Opening a saved item shows a plain snapshot first, so a page that depended on the network can never stall offline reading. Saved scripts do not run until you ask for them. The bar above it carries the page title and site, page-to-page navigation for multi-page saves, a scripts switch when scripts were saved, and a button to open the live page. Turning scripts on is remembered for the rest of that reading session. The scripts switch is experimental: it re-runs a page's bundles on a DOM that already ran them, which on script-driven sites can draw content twice.

The reader remembers. The tab is named after the page; the page list beside the reader ("In this save") marks what has been read; ← and → step between pages; and the scroll position of every page is kept in a small store beside the pack — never inside it, so reading a 30 MB save does not rewrite a 30 MB row — and restored when the page is opened again.

Rendering is in two parts. The reader sends the sandbox the page's markup with every resource still a `__PAGEPACK_RESOURCE_n__` token, and the resources as Blobs. For the plain snapshot the sandbox parses that markup with `DOMParser`, replaces the tokens in the tree with `blob:` URLs it mints itself, and adopts the tree in one move; nothing fetches during the parse and no script runs. With scripts on it goes through `document.write` instead, because that is the only way an inline `document.write` lands where the author put it, with the tokens replaced in the string in a single pass first. Either way no document ever contains the base64 of the page, which is what used to make a 30 MB page unopenable.

Every link in a saved page is intercepted, including links marked to open in a new
tab. If the target is in the save, the reader goes there; if it is not, the reader
says so and offers to open it online. Nothing in a saved page can reach the
network by itself — opening the live page is always a decision you make in the
reader's own interface.
