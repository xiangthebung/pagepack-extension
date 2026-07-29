/**
 * Builds the Chrome Web Store artifacts from the built extension.
 *
 *   npm run build && node scripts/store-shots.mjs
 *   npm install --no-save playwright   (once, if it is not already there)
 *
 * Writes `store-assets/`: four 1280x800 screenshots and the 440x280 promotional
 * tile, at exactly those sizes. The script measures its own output from the PNG
 * headers at the end and fails if a file is even one pixel off, because the store
 * rejects the upload rather than resizing it.
 *
 * Decisions worth knowing about.
 *
 * It loads `dist/`, not the repo root. `dist/` is what `npm run zip` packages and
 * what a reviewer installs, so it is what the pictures have to come from.
 *
 * Every pixel of PagePack in these files was rendered by PagePack. A real
 * Chromium loads the real build; the popup, the reader and the sandboxed page
 * frame are their own documents; the library really contains saved pages, put
 * there by clicking Save in the popup; the progress bar in the first shot is the
 * extension reporting on a capture that is genuinely in flight. The only things
 * this tool draws are the caption bands, the labels on the panels, and the
 * promotional tile.
 *
 * The pages being saved are a publication that does not exist, served from
 * `http://localhost:<port>` by the server below. PagePack asks for host access to
 * every site, so unlike a per-site extension it needs no particular host to work
 * and the pages can be invented outright — nothing here names, depicts or imitates
 * anybody. The masthead says as much on the page itself, and the composition
 * repeats it in the corner of every shot, because the reader shots show that page
 * full-bleed and a picture that leaves the difference to be guessed at is asking
 * to be misread.
 *
 * The assets on those pages are served slowly on purpose for the first shot.
 * PagePack's progress bar is only determinate for a single-page save, where the
 * file count is known before the fetching starts (`runCapture` in
 * `background.js`), so the first shot is a depth-0 save of a page carrying 20-odd
 * stylesheets and illustrations, each answered after a delay. The script then
 * polls the popup until the extension's own bar is somewhere near halfway and
 * shoots it there. Nothing about the number is staged: it is read back off the
 * popup and printed to stdout with the rest of the run.
 *
 * The offline shot is offline. `context.setOffline(true)` puts Chromium's network
 * stack into the same state as a pulled cable, and the local server that fed every
 * capture above becomes as unreachable as anything else — which is checked, on an
 * address the extension has never seen, and fails with ERR_INTERNET_DISCONNECTED
 * before either half of that picture is taken. Then a tab navigates to an address
 * PagePack did save. That navigation fails too, `chrome.webNavigation.onErrorOccurred`
 * in `background.js` recognises the error, looks the address up in the local URL
 * index, and sends the tab to `viewer.html` instead. Beside it is the popup in the
 * same browser at the same moment, which says "You're offline" because it really is:
 * that is the one question it asks, and the answer is not staged.
 *
 * The browser's own error page is deliberately not in the picture. Headless Chromium
 * renders it without its strings — a dinosaur, no heading — so a screenshot of it
 * would read as a broken screenshot rather than as a browser with no network.
 *
 * Composition happens in the browser rather than through an image library. The
 * page being screenshotted is already a layout engine, so putting one PNG on top
 * of another is less code than a dependency, and the caption typography is set in
 * CSS instead of measured by hand. Every source is captured at exactly the size it
 * is placed at: the popup is photographed in a 400x600 window because that is the
 * size Chrome gives it, and it is placed at 400x600. Enlarging a PNG afterwards
 * only produces a soft one, and the library is a 400px column at every window
 * size (`popup.css`), so three of them side by side is what fills 1280 honestly.
 *
 * Two things are held still so that two runs of the same commit produce the same
 * pictures. `extensionpay.com` is made unresolvable, so the plan line comes from
 * the local free-tier counter instead of whatever a payment provider says today —
 * `getProviderStatus` already falls back to "unknown" and the popup already
 * renders that as a sentence rather than a number. And the browser is asked for
 * reduced motion, which turns off the indeterminate bar's slide, the reader's
 * floating loader and the switch transitions, so nothing can be caught halfway
 * through an animation.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import playwright from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const out = path.join(root, 'store-assets');

/** Store sizes. The band is the caption strip; the stage is the picture under it. */
const WIDTH = 1280;
const HEIGHT = 800;
const BAND = 132;
const STAGE = HEIGHT - BAND;
/** The strip that labels each panel of a multi-panel shot. */
const LABEL = 26;
/** `popup.css` fixes html and body at this size, which is the size Chrome opens. */
const POPUP = { width: 400, height: 600 };
const TILE = { width: 440, height: 280 };
/**
 * The reader, beside the popup in the offline shot. Wide enough that the reader bar
 * keeps the saved page's own address on screen: below 720px `viewer.css` drops the
 * subtitle, and the address is half the point of that picture.
 */
const READER_PANEL = { width: 812, height: POPUP.height };

const dataUrl = (buffer) => `data:image/png;base64,${buffer.toString('base64')}`;
const fileUrl = (file) => dataUrl(readFileSync(file));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------ the stand-in ------------------------------ */

/**
 * A publication that does not exist, written for these screenshots.
 *
 * It has to be a plausible thing to save for later and nothing more: no wordmark,
 * no imitation of anybody's layout, and copy that could not be mistaken for a real
 * article. Long-form walking notes were chosen because "no signal after the second
 * bridge" is the reason somebody would reach for this extension in the first
 * place, which makes the screenshots argue for themselves.
 *
 * Eight pages. Four of them are linked from the front page, so a depth-1 save from
 * there collects five pages into one item; the rest are only reachable from those,
 * so they stay out of that pack and get saved separately, which is what gives the
 * library something other than one enormous row.
 *
 * Four and not seven, because the row of pages the library shows for an expanded
 * item has to end inside the popup's 600px rather than be sliced off at the bottom
 * of it. That is the only reason the number is what it is.
 */
const SITE_NAME = 'Coldwater Field Notes';
const DISCLOSURE = 'An invented publication, written to photograph this extension. Not a real site.';
/**
 * `.example` is reserved by RFC 2606, so this can never be anybody's address, and
 * the name is invented. The pages really are served over HTTP from a local server;
 * the browser is told to resolve this name to it with `--host-resolver-rules`, which
 * is the same thing a hosts file would do. `localhost:52413` would have worked
 * exactly as well for the extension — it asks for access to every http(s) site — but
 * it photographs as somebody's dev machine, and the hostname is on screen in the
 * popup's target card and again in the reader's subtitle.
 */
const HOST = 'coldwater.example';
const ORIGIN = `http://${HOST}`;

const PAGES = [
  {
    slug: '',
    title: 'Three days on the Coldwater traverse',
    kicker: 'ROUTE NOTES',
    standfirst:
      'Thirty-one kilometres, eleven hundred metres of climb, and no signal after the second bridge. Which is the reason to write it all down before you go.',
    body: [
      ['p', 'Nothing about the traverse is technical. What turns people back is water: there is a great deal of it in May and almost none by the end of August, and a printed map has no opinion about which month it is. Before you leave, read [/water|where the water is] and copy the three reliable sources onto something that does not need a battery.'],
      ['fig', 0, 'The first ridge, seen from the logging road at about six in the morning.'],
      ['h2', 'Day one — the logging road'],
      ['p', 'The road climbs for nine kilometres at a gradient that feels like nothing for the first hour and like a great deal for the third. There is shade on the eastern side until about eleven. After the switchbacks the surface turns to loose plate and the walking gets slower rather than steeper, which is worth knowing if you are pacing yourself against the map.'],
      ['p', 'The old cut block at the top is the last flat ground before the saddle, and the last place with a view of the valley you drove in through. Most people stop here whether they planned to or not.'],
      ['fig', 1, 'Second-growth on the cut block, with the saddle behind it.'],
      ['h2', 'Day two — the saddle and the long shelf'],
      ['p', 'The saddle is the only part of the route where the weather can genuinely change your plans, and the only part with nowhere to shelter. [/weather|Reading the weather from the valley floor] covers what the cloud on the far ridge is telling you at seven in the morning; the short version is that if you cannot see the notch, you are not crossing today.'],
      ['fig', 2, 'The notch, on a morning when it was visible.'],
      ['p', 'Past the saddle the route becomes a shelf that traverses for six kilometres with almost no elevation change. It is the pleasantest walking on the route and the easiest place to lose the line, because the shelf is wide and the cairns are old. Keep the drop on your right and you cannot get it wrong.'],
      ['fig', 3, 'The shelf, looking back towards the saddle in the late afternoon.'],
      ['h2', 'Day three — down the creek'],
      ['p', 'The descent follows the creek through four kilometres of blowdown that has been getting worse every year since the storm. It is tedious rather than dangerous. Gaiters help, a folded saw does not, and everything you actually need is in [/packing|what to carry for three days].'],
      ['fig', 4, 'Blowdown in the lower creek, three summers after the storm.'],
      ['p', 'The last bridge is out and has been for two seasons. The crossing below it is knee-deep in September and thigh-deep in June, and the far bank is the first place a phone will find anything at all.'],
      ['fig', 5, 'The crossing, at the end of a dry summer.'],
      ['p', 'One last thing, and it is the whole reason these notes exist on paper as well as here: fold the map before you leave the car. [/maps|Paper maps, and how to fold one properly] explains why the standard fold puts the crease exactly where you will need to read.'],
    ],
  },
  {
    slug: 'water',
    title: 'Where the water is, and where it is not',
    kicker: 'FIELD NOTES',
    standfirst: 'Three sources hold through a dry August. Everything else on the map is a spring in May and a dry stone bed by the time you get there.',
    body: [
      ['p', 'The creek at the foot of the logging road runs all year. So does the seep on the north side of the saddle, though it takes twenty minutes to fill two litres and you will be cold by the end of it. The third is the ford itself, at the very end, which is more of a consolation than a plan.'],
      ['fig', 0, 'The seep on the north side of the saddle, in August.'],
      ['h2', 'What the map promises'],
      ['p', 'Six blue lines cross the shelf on the printed sheet. In late summer, none of them carry water. They are drawn from a survey taken in a wet decade and nobody has been back to correct them, which is not the surveyor\u2019s fault and is still your problem at four in the afternoon.'],
      ['fig', 1, 'A dry bed on the shelf, marked as a stream on every edition of the map.'],
      ['h2', 'How much to carry'],
      ['p', 'Three litres between the road and the saddle in August, two in June. There is no shade on the shelf and no reason to be brave about it. Filter everything; the cut block is grazed in the early summer and the creek below it tastes like it.'],
      ['fig', 2, 'The creek at the foot of the road, which has never been known to fail.'],
    ],
  },
  {
    slug: 'packing',
    title: 'What to carry for three days',
    kicker: 'LISTS',
    standfirst: 'A list that has been cut down over nine crossings. Everything on it has been used; everything that was not has gone.',
    body: [
      ['p', 'The pack that works for this route weighs eleven kilograms with water and food. That is not light by any competitive standard and it is a great deal lighter than the first time, mostly because of what came out rather than what went in.'],
      ['fig', 0, 'Everything, laid out on the floor the night before.'],
      ['h2', 'Worn and carried'],
      ['p', 'Boots that have already done a hundred kilometres, not new ones. Two pairs of socks and a third kept dry in a bag for sleeping only. A wind shell that packs to the size of a fist, and a warm layer you would be happy to sit still in for an hour at the notch.'],
      ['fig', 1, 'Socks, in the only arrangement that has ever worked.'],
      ['h2', 'Food, and the stove argument'],
      ['p', 'Three days of food is easier to get right than two, because you stop trying to be clever. A stove is worth its weight for the second evening alone. [/tea|Boiling water at altitude] is the only reason the numbers on the fuel canister do not apply here.'],
      ['fig', 2, 'The stove, on the flat rock everybody uses.'],
      ['p', 'Boots get wet at the ford whatever you do. [/boots|Drying boots without a fire] is the difference between the third day being pleasant and being something you complain about for a year.'],
    ],
  },
  {
    slug: 'weather',
    title: 'Reading the weather from the valley floor',
    kicker: 'FIELD NOTES',
    standfirst: 'You get one look at the ridge before you commit to the saddle. This is what to look for, and what it has meant the last nine times.',
    body: [
      ['p', 'At seven in the morning, from the cut block, you can see the notch and about four kilometres of the far ridge. If the notch is in cloud and the ridge below it is clear, the cloud is sitting still and will burn off by ten. If the ridge is in cloud and the notch is clear, it is coming towards you and you have about two hours.'],
      ['fig', 0, 'Cloud sitting on the notch at seven, gone by ten.'],
      ['h2', 'The forecast you cannot get'],
      ['p', 'There is no signal from the moment you leave the road, so whatever forecast you have is the one you read in the car. Save it before you leave the tarmac and read the sky against it rather than instead of it.'],
      ['fig', 1, 'The far ridge, on a morning that turned out badly.'],
      ['h2', 'Wind on the shelf'],
      ['p', 'The shelf funnels anything from the south-west and gives you nothing to hide behind for six kilometres. It is the one place on the route where a wind shell stops being a comfort and starts being the reason you keep walking.'],
      ['fig', 2, 'The shelf in a south-westerly.'],
    ],
  },
  {
    slug: 'repairs',
    title: 'Field repairs with what is in your pocket',
    kicker: 'FIELD NOTES',
    standfirst: 'A boot sole, a pack strap and a pole section, mended well enough to walk out on. None of these are permanent and all of them have worked.',
    body: [
      ['p', 'Two metres of tape wound round a pole and a metre of cord is the entire repair kit. Everything below has been done with those two things and whatever was already in the pack.'],
      ['fig', 0, 'The whole repair kit, wound round a pole section.'],
      ['h2', 'A sole that has let go'],
      ['p', 'Tape does not stick to a wet sole and never will. Dry the seam against your leg for ten minutes first, then bind across the sole and up the sides rather than round the toe, which is where the flex is. It will hold for a day and a half.'],
      ['fig', 1, 'A bound sole, twelve kilometres after it was done.'],
      ['h2', 'A strap that has torn out'],
      ['p', 'Cord through the remaining webbing and back round the frame carries the load well enough to walk out. Do not try to restore the original geometry; get the weight onto your hips and accept that the pack now sits crooked.'],
      ['fig', 2, 'A shoulder strap carried on cord for the last day.'],
    ],
  },
  {
    /**
     * The page photographed mid-capture, so it is the one carrying the most to
     * fetch: eight illustrations, two stylesheets, the masthead mark, three rail
     * thumbnails and four archive plates. Eighteen files, which is a count worth
     * putting a progress bar in front of.
     */
    slug: 'maps',
    title: 'Paper maps, and how to fold one properly',
    kicker: 'METHOD',
    standfirst: 'The standard fold puts a crease straight through the saddle. Two extra folds put the part you need in the palm of your hand and keep it dry.',
    body: [
      ['p', 'A map folded the way it came out of the shop has a crease exactly where the route crosses the height of land, and that crease is where the paper will fail first, because it is the part you open and close all day.'],
      ['fig', 0, 'The standard fold, creased through the part that matters.'],
      ['h2', 'The fold that works'],
      ['p', 'Fold once along the route rather than along the sheet, so the line you are following sits in the middle of a panel. Then fold that panel in half twice more. What you end up with is roughly the size of a passport, shows about eight kilometres, and can be read in one hand in wind.'],
      ['fig', 1, 'The finished fold, about the size of a passport.'],
      ['p', 'The panel you want on the last morning is the one with the ford on it, and that is never the panel the standard fold leaves on the outside.'],
      ['fig', 2, 'The panel that matters, on the outside where it belongs.'],
      ['h2', 'Keeping it dry'],
      ['p', 'A freezer bag is better than a map case: it weighs nothing, it does not rattle, and when it fails it fails by leaking rather than by trapping water against the paper.'],
      ['fig', 3, 'A folded sheet in a freezer bag, after three wet days.'],
      ['h2', 'Marking it up'],
      ['p', 'Pencil, not pen, and mark the water rather than the route — the route is already drawn and the water is the thing the sheet gets wrong. Three circles is usually the whole annotation.'],
      ['fig', 4, 'Three circles, which is the whole annotation.'],
      ['h2', 'What to do with it afterwards'],
      ['p', 'Unfold it flat the evening you get home and leave it under something heavy overnight. A sheet stored folded along a wet crease will tear along that crease the next time it is opened in wind.'],
      ['fig', 5, 'A sheet drying flat under something heavy.'],
      ['h2', 'The second sheet'],
      ['p', 'Carry the neighbouring sheet as well, folded the same way and left in the pack. It weighs nothing and it is the only thing that helps when the route you meant to walk turns out to be under snow.'],
      ['fig', 6, 'The neighbouring sheet, folded and never opened.'],
      ['h2', 'Why not the phone'],
      ['p', 'The phone is better at every part of this except the one that matters, which is being readable at the end of the third day. Take both and expect to use the paper.'],
      ['fig', 7, 'Both, on the tailgate, at the end of the third day.'],
    ],
  },
  {
    slug: 'tea',
    title: 'Boiling water at altitude',
    kicker: 'METHOD',
    standfirst: 'Water boils cooler up here, which is why the numbers printed on a fuel canister have never once been right on this route.',
    body: [
      ['p', 'At the saddle water boils somewhere near ninety-four degrees. Nothing dramatic follows from that except that everything takes longer, and longer means more fuel than the canister claims for the same number of meals.'],
      ['fig', 0, 'Boiling at the saddle, taking its time.'],
      ['h2', 'What to plan for'],
      ['p', 'Add a third to whatever the canister says for three days of two hot meals. Wind costs more fuel than altitude does; a windbreak made of a pack and a rock has saved more gas than any change of stove.'],
      ['fig', 1, 'A windbreak made of a pack and a rock.'],
      ['p', 'The one that matters is the last morning, after the ford, when everything is wet and nobody is willing to wait twelve minutes for water.'],
    ],
  },
  {
    slug: 'boots',
    title: 'Drying boots without a fire',
    kicker: 'METHOD',
    standfirst: 'The ford soaks both boots on the last morning. Newspaper is the answer, and there is a right amount of it.',
    body: [
      ['p', 'Two sheets, loosely balled, changed once before you sleep, will take a wet boot to merely damp by morning. Packed tight they do nothing, because it is the air moving through the paper that does the work rather than the paper itself.'],
      ['fig', 0, 'Two sheets, balled loosely, in a boot that went through the ford.'],
      ['h2', 'What not to do'],
      ['p', 'Do not put them near a fire, and do not wear damp socks to make it faster. A boot dried hard shrinks and stays shrunk, and there is no repair for that in the kit.'],
      ['fig', 1, 'A boot dried too fast, two seasons ago.'],
    ],
  },
];

const pageBySlug = new Map(PAGES.map((page) => [page.slug, page]));

/** Deterministic. Two runs of the same commit must draw the same illustrations. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A landscape illustration, drawn rather than photographed.
 *
 * SVG so the repository still contains no binary media, and so each one is a
 * genuine separate request the capture has to go and fetch. Four ridge layers over
 * a graded sky, in the blues the extension itself uses, with the palette rotated
 * per figure so a page of them does not read as one repeated tile.
 */
function ridgeSvg(seed, { width = 1120, height = 630 } = {}) {
  const random = mulberry32(seed * 977 + 13);
  const hue = 196 + ((seed * 37) % 44) - 22;
  const layers = [];
  const count = 4;
  for (let layer = 0; layer < count; layer += 1) {
    const baseY = height * (0.42 + layer * 0.13);
    const amplitude = height * (0.16 - layer * 0.025);
    const steps = 9;
    const points = [];
    for (let step = 0; step <= steps; step += 1) {
      const x = (width * step) / steps;
      const drift = Math.sin(step * 0.85 + seed + layer) * amplitude * 0.55;
      points.push([x, baseY + drift - random() * amplitude]);
    }
    let path = `M0 ${height} L${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
    for (let index = 1; index < points.length; index += 1) {
      const [previousX, previousY] = points[index - 1];
      const [x, y] = points[index];
      const midX = (previousX + x) / 2;
      path += ` Q${previousX.toFixed(1)} ${previousY.toFixed(1)} ${midX.toFixed(1)} ${((previousY + y) / 2).toFixed(1)}`;
      path += ` Q${x.toFixed(1)} ${y.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    path += ` L${width} ${height} Z`;
    const lightness = 74 - layer * 15;
    const saturation = 26 + layer * 6;
    layers.push(`<path d="${path}" fill="hsl(${hue} ${saturation}% ${lightness}%)"/>`);
  }
  const sunX = width * (0.2 + ((seed * 13) % 60) / 100);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="hsl(${hue} 44% 88%)"/>
    <stop offset="1" stop-color="hsl(${hue + 14} 34% 96%)"/>
  </linearGradient></defs>
  <rect width="${width}" height="${height}" fill="url(#sky)"/>
  <circle cx="${sunX.toFixed(0)}" cy="${(height * 0.2).toFixed(0)}" r="${(height * 0.07).toFixed(0)}" fill="#fff" opacity=".78"/>
  ${layers.join('\n  ')}
</svg>`;
}

/** The masthead mark. Not a logo of anything; three strokes and a rule. */
const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">
  <circle cx="36" cy="36" r="34" fill="none" stroke="#1d3a5c" stroke-width="2.5"/>
  <path d="M14 47l13-17 9 11 7-9 15 15z" fill="#1d3a5c" opacity=".82"/>
  <circle cx="49" cy="23" r="5.5" fill="#1d3a5c" opacity=".5"/>
</svg>`;

/** A thumbnail for the side rail and the archive plates. One request each. */
function thumbSvg(seed) {
  const hue = 202 + ((seed * 29) % 40) - 20;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="120" viewBox="0 0 180 120">
  <rect width="180" height="120" fill="hsl(${hue} 36% 90%)"/>
  <path d="M0 88l38-34 26 20 22-26 44 40 50-30v62H0z" fill="hsl(${hue} 30% 62%)"/>
  <path d="M0 104l52-24 40 18 34-14 54 24v12H0z" fill="hsl(${hue} 26% 44%)"/>
</svg>`;
}

const SITE_CSS = `@import url("/type.css");
:root {
  --ink: #16181c;
  --soft: #55595f;
  --faint: #8b8f96;
  --rule: #e2e0da;
  --paper: #fbfaf7;
  --accent: #12507f;
}
* { box-sizing: border-box; }
html { background: var(--paper); }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font: 19px/1.62 Georgia, "Iowan Old Style", "Times New Roman", serif;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-underline-offset: 2px; }
img { display: block; max-width: 100%; height: auto; }
.masthead {
  display: flex;
  align-items: center;
  gap: 14px;
  max-width: 1240px;
  margin: 0 auto;
  padding: 20px 44px 16px;
}
.masthead img { width: 38px; height: 38px; }
.masthead-copy { display: grid; gap: 1px; }
.masthead strong {
  font-family: var(--sans);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: .16em;
  text-transform: uppercase;
}
.masthead small { color: var(--faint); font-family: var(--sans); font-size: 12px; }
nav {
  border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
  background: rgba(255, 255, 255, .6);
}
nav ul {
  display: flex;
  gap: 26px;
  max-width: 1240px;
  margin: 0 auto;
  padding: 11px 44px;
  list-style: none;
}
nav a {
  color: var(--soft);
  font-family: var(--sans);
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: .01em;
  text-decoration: none;
}
nav a:hover { color: var(--accent); }
/* A column and a rail, rather than one column down the middle.
   The rail is the part the extension's popup covers up in the first screenshot, so
   nothing that matters is behind it; at 1280 it is also what keeps the right third
   of the reader shots from being empty paper. */
.layout {
  display: flex;
  gap: 48px;
  max-width: 1240px;
  margin: 0 auto;
  padding: 0 44px;
}
article { width: 700px; flex: none; padding: 34px 0 64px; }
.rail { width: 300px; flex: none; margin: 40px 0 0 auto; }
@media (max-width: 1120px) {
  .layout { display: block; }
  article { width: auto; max-width: 700px; }
  .rail { width: auto; margin: 44px 0 0; }
}
.kicker {
  margin: 0;
  color: var(--accent);
  font-family: var(--sans);
  font-size: 11.5px;
  font-weight: 800;
  letter-spacing: .18em;
}
h1 {
  margin: 12px 0 0;
  font-size: 41px;
  font-weight: 700;
  letter-spacing: -.022em;
  line-height: 1.1;
}
.standfirst { margin: 14px 0 0; color: var(--soft); font-size: 21px; line-height: 1.5; }
.byline {
  margin: 18px 0 0;
  padding: 0 0 22px;
  border-bottom: 1px solid var(--rule);
  color: var(--faint);
  font-family: var(--sans);
  font-size: 12.5px;
}
h2 { margin: 38px 0 0; font-size: 25px; font-weight: 700; letter-spacing: -.012em; }
p { margin: 18px 0 0; }
figure { margin: 30px 0 0; }
figure img { border-radius: 6px; }
figcaption { margin: 9px 0 0; color: var(--faint); font-family: var(--sans); font-size: 12.5px; line-height: 1.45; }
.rail h2 {
  margin: 0 0 2px;
  padding: 0 0 10px;
  border-bottom: 1px solid var(--rule);
  font-family: var(--sans);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: .14em;
  text-transform: uppercase;
}
.rail ul { margin: 0; padding: 0; list-style: none; }
.rail li { display: flex; gap: 13px; padding: 14px 0; border-bottom: 1px solid var(--rule); }
.rail img { width: 84px; height: 56px; flex: none; border-radius: 4px; }
.rail a { font-family: var(--sans); font-size: 14.5px; font-weight: 600; line-height: 1.35; text-decoration: none; }
.rail span span { display: block; margin: 3px 0 0; color: var(--faint); font-family: var(--sans); font-size: 12px; }
.plate-title {
  margin: 26px 0 10px;
  color: var(--faint);
  font-family: var(--sans);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: .14em;
  text-transform: uppercase;
}
.plates { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.plates img { width: 100%; height: auto; border-radius: 4px; }
footer {
  max-width: 1240px;
  margin: 0 auto;
  padding: 22px 44px 46px;
  border-top: 1px solid var(--rule);
  color: var(--faint);
  font-family: var(--sans);
  font-size: 12.5px;
}
`;

const TYPE_CSS = `:root { --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
::selection { background: rgba(18, 80, 127, .16); }
`;

/** Collected as a stylesheet like any other, and one more file to fetch. */
const PRINT_CSS = `@media print {
  nav, .related { display: none; }
  body { font-size: 11pt; }
}
`;

function linkify(text) {
  return text.replace(/\[([^|\]]+)\|([^\]]+)\]/g, (_full, href, label) => `<a href="${href}">${label}</a>`);
}

/**
 * Three items, not eight.
 *
 * Every link to a page that is in the same save gets a "✓ Saved" pill from the
 * reader, which is the point of the third screenshot — but a nav bar of five of
 * them reads as a rendering fault rather than a feature. The front page still
 * links to all five of its siblings from the body copy, so the depth-1 save is
 * unaffected; only the number of pills across the top changes.
 */
const NAV = [
  ['', 'Route notes'],
  ['water', 'Water'],
  ['maps', 'Maps and method'],
];

/**
 * The side rail, which is also the rest of the depth-1 save.
 *
 * These four addresses, plus the nav, are every link on the front page, so they are
 * exactly the pages that end up in the one five-page item in the library. The
 * current page drops out of its own rail, as it would anywhere else.
 */
const RAIL = ['water', 'packing', 'weather', 'maps'];

function renderPage(page) {
  const navItems = NAV.map(([slug, label]) => `<li><a href="/${slug}">${label}</a></li>`).join('');
  const rail = RAIL.filter((slug) => slug !== page.slug).map((slug, index) => {
    const item = pageBySlug.get(slug);
    return `<li><img src="/img/thumb-${index}.svg" width="84" height="56" alt="">
          <span><a href="/${item.slug}">${item.title}</a><span>${item.kicker.toLowerCase()}</span></span></li>`;
  }).join('');
  const blocks = page.body
    .map((block) => {
      if (block[0] === 'p') return `<p>${linkify(block[1])}</p>`;
      if (block[0] === 'h2') return `<h2>${block[1]}</h2>`;
      const index = block[1];
      /**
       * One `src`, and deliberately no `srcset`.
       *
       * PagePack tokenises `srcset` when the page is read out of the tab
       * (`rewriteSrcset` in `content.js`) but not when a page is fetched as a
       * followed link (`extractAndTokenizeResources` in `background.js` only
       * rewrites `src`, `href` and `poster`). A saved child page therefore keeps its
       * original `srcset`, the browser prefers `srcset` over `src`, and offline the
       * figure comes up as a broken image — which the run below catches and refuses
       * to photograph. Responsive markup here would make these screenshots a picture
       * of that defect rather than of the extension.
       */
      return `<figure><img src="/img/${page.slug || 'traverse'}-${index}.svg" width="680" height="383" alt=""><figcaption>${block[2]}</figcaption></figure>`;
    })
    .join('\n      ');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${page.title}</title>
    <link rel="stylesheet" href="/style.css">
    <link rel="stylesheet" href="/print.css" media="print">
  </head>
  <body>
    <header class="masthead">
      <img src="/img/mark.svg" width="38" height="38" alt="">
      <span class="masthead-copy">
        <strong>${SITE_NAME}</strong>
        <small>${DISCLOSURE}</small>
      </span>
    </header>
    <nav><ul>${navItems}</ul></nav>
    <div class="layout">
      <article>
        <p class="kicker">${page.kicker}</p>
        <h1>${page.title}</h1>
        <p class="standfirst">${page.standfirst}</p>
        <p class="byline">Sample copy · no author, no date, no real place</p>
        ${blocks}
      </article>
      <aside class="rail">
        <h2>More field notes</h2>
        <ul>${rail}</ul>
        <!-- Pictures, and no links: a link here would be another page for a
             link-following save to collect, and the size of that save is the
             point of one of the screenshots. -->
        <p class="plate-title">From the archive</p>
        <div class="plates">${[0, 1, 2, 3]
          .map((index) => `<img src="/img/plate-${index}.svg" width="84" height="56" alt="">`)
          .join('')}</div>
      </aside>
    </div>
    <footer>${SITE_NAME} does not exist. These pages were written to photograph a browser extension.</footer>
  </body>
</html>`;
}

/**
 * The stand-in server.
 *
 * `assetDelay` is the only moving part: it is turned up for the shot of a capture
 * in progress and left near zero for everything else, so the progress bar has
 * something to be partway through without every other save taking a minute.
 */
function startSite() {
  const state = { assetDelay: 0 };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const send = (type, body, delay = 0) => {
      const finish = () => {
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        response.end(body);
      };
      if (delay > 0) setTimeout(finish, delay);
      else finish();
    };
    const pathname = url.pathname;
    if (pathname === '/style.css') return send('text/css; charset=utf-8', SITE_CSS, state.assetDelay);
    if (pathname === '/type.css') return send('text/css; charset=utf-8', TYPE_CSS, state.assetDelay);
    if (pathname === '/print.css') return send('text/css; charset=utf-8', PRINT_CSS, state.assetDelay);
    if (pathname === '/img/mark.svg') return send('image/svg+xml; charset=utf-8', MARK_SVG, state.assetDelay);
    const small = pathname.match(/^\/img\/(thumb|plate)-(\d+)\.svg$/);
    if (small) {
      const seed = Number(small[2]) + (small[1] === 'plate' ? 11 : 3);
      return send('image/svg+xml; charset=utf-8', thumbSvg(seed), state.assetDelay);
    }
    const figure = pathname.match(/^\/img\/([a-z]+)-(\d+)\.svg$/);
    if (figure) {
      const seed = [...figure[1]].reduce((total, character) => total + character.charCodeAt(0), Number(figure[2]) * 7);
      return send('image/svg+xml; charset=utf-8', ridgeSvg(seed), state.assetDelay);
    }
    const page = pageBySlug.get(pathname.replace(/^\/|\/$/g, ''));
    if (page) return send('text/html; charset=utf-8', renderPage(page));
    response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Not found</title><h1>Not found</h1>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, state, port, origin: ORIGIN });
    });
  });
}

/* ------------------------------- composition ------------------------------ */

/**
 * The caption band, in the product's own tokens (`popup.css`). A listing that does
 * not look like the thing it is selling makes the reader wonder which of the two is
 * out of date.
 */
const STYLE = `
  * { box-sizing: border-box }
  /* Every margin in here is stated. A default 1em on a label is 25px of height the
     panel below it does not have, and the first version of this file lost the top
     label off the edge of the picture that way. */
  p, h1 { margin: 0 }
  body {
    width: ${WIDTH}px;
    height: ${HEIGHT}px;
    margin: 0;
    overflow: hidden;
    background: #f2f2f6;
    color: #1d1d1f;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .head {
    display: flex;
    height: ${BAND}px;
    flex-direction: column;
    justify-content: center;
    padding: 0 54px;
    background:
      radial-gradient(115% 300% at 100% 0%, rgba(0, 122, 255, .12) 0%, transparent 62%),
      #ffffff;
  }
  .eyebrow {
    margin: 0;
    color: #0066cc;
    font-size: 11.5px;
    font-weight: 800;
    letter-spacing: .17em;
    text-transform: uppercase;
  }
  h1 {
    margin: 9px 0 0;
    font-size: 31px;
    font-weight: 700;
    letter-spacing: -.026em;
    line-height: 1.14;
  }
  .note { margin: 7px 0 0; max-width: 1080px; color: #55585e; font-size: 15.5px }
  .stage {
    position: relative;
    width: ${WIDTH}px;
    height: ${STAGE}px;
    overflow: hidden;
    border-top: 1px solid rgba(60, 60, 67, .16);
  }
  img.page { display: block; width: ${WIDTH}px; height: ${STAGE}px }
  img.popup {
    position: absolute;
    top: 36px;
    right: 38px;
    border-radius: 14px;
    box-shadow:
      0 0 0 1px rgba(60, 60, 67, .14),
      0 30px 70px -22px rgba(20, 24, 33, .55);
  }
  /* Real panels, side by side, each photographed at exactly the size it sits at and
     labelled with what it is. The library is a 400px column at every window size,
     fixed in popup.css, so three of them is the honest way to fill 1280 with it, and
     20px of gutter is what that leaves. */
  .cards {
    display: flex;
    height: 100%;
    align-items: flex-start;
    justify-content: center;
    gap: 20px;
    padding-top: 14px;
    background: radial-gradient(90% 130% at 50% 0%, #ffffff 0%, #e9ebf1 100%);
  }
  .cards .col { display: grid }
  .cards .lab {
    display: flex;
    height: ${LABEL}px;
    align-items: center;
    padding-left: 2px;
    color: #55585e;
    font-size: 12.5px;
    font-weight: 650;
    letter-spacing: .01em;
  }
  .cards .lab.is-on { color: #0066cc }
  .cards img {
    display: block;
    border-radius: 14px;
    box-shadow:
      0 0 0 1px rgba(60, 60, 67, .13),
      0 22px 50px -24px rgba(20, 24, 33, .45);
  }

  /* Says out loud that the publication under the extension is invented. Three
     positions, because the one thing it must not do is land on the extension's own
     words or on a sentence somebody is trying to read. */
  .stamp {
    position: absolute;
    right: 13px;
    bottom: 12px;
    padding: 5px 9px;
    border-radius: 7px;
    color: rgba(255, 255, 255, .94);
    background: rgba(22, 24, 28, .62);
    font-size: 10.5px;
    font-weight: 600;
  }
  .stamp.left { right: auto; left: 13px }
  .stamp.below { bottom: 4px }
`;

function frame({ eyebrow, title, note, body, stampAt = 'right' }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head>
<body>
  <div class="head">
    <p class="eyebrow">${eyebrow}</p>
    <h1>${title}</h1>
    <p class="note">${note}</p>
  </div>
  <div class="stage">
    ${body}
    <span class="stamp ${stampAt}">${STAND_IN}</span>
  </div>
</body></html>`;
}

const STAND_IN = 'Invented publication &middot; every pixel of PagePack is the shipped build';

/**
 * 440x280. The real icon, the name, and the promise the code can keep.
 *
 * Laid out to match `store-assets/promo-440x280.svg`, which was drawn by hand
 * first: same palette, same two lines, same pair of sheets on the right. Keeping
 * them in step means the vector stays a usable source for anything that needs one
 * larger, rather than a second version of the tile that quietly disagrees.
 */
function tile(icon) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box }
  body {
    position: relative;
    display: flex;
    width: ${TILE.width}px;
    height: ${TILE.height}px;
    flex-direction: column;
    justify-content: center;
    margin: 0;
    padding: 0 34px;
    overflow: hidden;
    background:
      radial-gradient(105% 130% at 82% 4%, #174579 0%, #1b202a 47%, #111216 100%);
    color: #f5f5f7;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .row { display: flex; align-items: center; gap: 14px }
  img { display: block; width: 52px; height: 52px }
  .name { font-size: 23px; font-weight: 700; letter-spacing: -.02em }
  .eyebrow {
    margin: 34px 0 0;
    color: #4da1ff;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: .19em;
  }
  h1 { margin: 12px 0 0; font-size: 29px; font-weight: 700; letter-spacing: -.03em; line-height: 1.18 }
  .sheets { position: absolute; right: 26px; bottom: 46px; width: 104px; height: 127px }
</style></head>
<body>
  <div class="row"><img src="${icon}" alt=""><span class="name">PagePack</span></div>
  <p class="eyebrow">OFFLINE WEB CLIPPER</p>
  <h1>Save it now.<br>Read it anywhere.</h1>
  <svg class="sheets" viewBox="0 0 104 127" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="19" y="1.5" width="76" height="96" rx="14" fill="#262e3a" stroke="#347dc8" stroke-width="3"/>
    <rect x="2" y="18.5" width="82" height="97" rx="15" fill="#0a84ff" stroke="#6db5ff" stroke-width="2"/>
    <path d="M25 66h35M25 82h39M25 98h28" stroke="#fff" stroke-width="5"/>
    <path d="M64 31.5v18m0 0-7-7m7 7 7-7" stroke="#fff" stroke-width="4"/>
  </svg>
</body></html>`;
}

async function shoot(context, name, html, size = { width: WIDTH, height: HEIGHT }) {
  const page = await context.newPage();
  await page.setViewportSize(size);
  await page.setContent(html, { waitUntil: 'load' });
  // Data URLs decode asynchronously; without this the first frame can be blank.
  await page.evaluate(() => Promise.all([...document.images].map((image) => image.decode())));
  await page.screenshot({ path: path.join(out, name) });
  await page.close();
  process.stdout.write(`  ${name}\n`);
}

/** Reads width and height out of the PNG header. No dependency, no guessing. */
function pngSize(file) {
  const buffer = readFileSync(file);
  if (buffer.length < 24 || buffer.readUInt32BE(12) !== 0x49484452) {
    throw new Error(`${path.basename(file)} is not a PNG with a leading IHDR chunk`);
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/* --------------------------- driving the extension ------------------------ */

/**
 * The popup, as its own document.
 *
 * There is no toolbar in an automated browser, so the popup has to be opened as a
 * page, and a page has no tab to describe but itself: `readActiveTab` would ask
 * for the active tab, get this one, and report — correctly — that Chrome does not
 * let extensions save its own pages. The stub narrows that one question to the
 * stand-in tab and answers it with Chrome's own reply, so everything the popup
 * then does, including the save it starts, is the extension's real behaviour
 * against a real tab.
 */
async function openPopup(context, extensionId, targetUrl) {
  const page = await context.newPage();
  await page.setViewportSize(POPUP);
  await page.addInitScript((url) => {
    const original = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = function query(_filter, callback) {
      return original({}, (tabs) => {
        const match = (tabs || []).filter((tab) => tab.url === url);
        callback(match.slice(0, 1));
      });
    };
  }, targetUrl);
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  // init() reads the tab, the library and the plan, then renders.
  await page.waitForFunction(() => {
    const title = document.getElementById('target-title')?.textContent || '';
    return title && title !== 'Reading the current tab…';
  }, null, { timeout: 20000 });
  await page.waitForFunction(
    () => !/Checking your plan/.test(document.getElementById('plan-summary')?.textContent || ''),
    null,
    { timeout: 20000 },
  );
  // If the tab lookup came back empty the popup renders "No page to save", which
  // would be a screenshot of the automation failing rather than of the extension.
  const host = await page.locator('#target-host').textContent();
  if (host !== new URL(targetUrl).hostname) {
    throw new Error(`the popup is describing "${host}" rather than ${new URL(targetUrl).hostname}`);
  }
  return page;
}

/** Creates a folder the way a user does: the + button, a name, Create. */
async function createFolder(popup, name) {
  await popup.click('#library-tab');
  await popup.click('#new-folder-button');
  await popup.fill('#new-folder-name', name);
  await popup.click('#new-folder-form button[type="submit"]');
  await popup.waitForFunction(
    (folderName) => [...document.querySelectorAll('.entry-title')].some((node) => node.textContent === folderName),
    name,
    { timeout: 10000 },
  );
}

/**
 * Picks a destination from the popup's own Save-to menu.
 *
 * Always, even for the top level: the extension remembers the last destination in
 * `SET_CAPTURE_PREFERENCES`, so a save that means to land in the library has to say
 * so rather than inherit the folder the previous one chose.
 */
async function chooseFolder(popup, name) {
  await popup.click('#save-tab');
  await popup.click('#save-folder-trigger');
  await popup.click(`#save-folder-menu .menu-item:has-text("${name}")`);
  await popup.waitForFunction(
    (folderName) => document.getElementById('save-folder-label')?.textContent === folderName,
    name,
    { timeout: 10000 },
  );
}

/**
 * The library, as the extension reports it, newest first.
 *
 * Asked through the extension's own message bus from an extension page, so this is
 * the same answer the popup renders. A refusal is raised rather than swallowed: a
 * missing reply here means the service worker went away, and quietly carrying on
 * would put a half-built library in the screenshots.
 */
async function library(page) {
  const reply = await page.evaluate(
    () =>
      new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'LIST_LIBRARY' }, (answer) =>
          resolve(answer ?? { error: chrome.runtime.lastError?.message || 'no reply' }),
        );
      }),
  );
  if (!Array.isArray(reply?.packs)) throw new Error(`LIST_LIBRARY failed: ${reply?.error || JSON.stringify(reply)}`);
  return reply.packs;
}

/** The frame the saved page is rendered in. Sandboxed, so it has its own document. */
function savedPageFrame(reader) {
  const found = reader.frames().find((candidate) => /sandbox\.html/.test(candidate.url()));
  if (!found) throw new Error('the reader has no sandboxed page frame');
  return found;
}

/** How many links the reader marked as opening from disk. */
function savedLinkCount(reader) {
  return savedPageFrame(reader).evaluate(
    () => document.querySelectorAll('a[data-pagepack-saved-link="true"]').length,
  );
}

/**
 * Every image in the rendered saved page, and any that did not come back.
 *
 * A saved page whose pictures are missing is the one thing a screenshot of an
 * offline reader must not quietly contain, and a broken one is easy to miss in a
 * shot where the figure happens to sit below the fold. This raises rather than
 * reports, because there is no version of this picture worth shipping with a broken
 * image icon in it.
 */
async function reportImages(reader, label) {
  const saved = savedPageFrame(reader);
  await saved.evaluate(() =>
    Promise.all([...document.images].map((image) => image.decode().catch(() => undefined))),
  );
  const state = await saved.evaluate(() => {
    const all = [...document.images];
    return {
      total: all.length,
      broken: all
        .filter((image) => image.complete && image.naturalWidth === 0)
        .map((image) => `${(image.currentSrc || image.src || '(none)').slice(0, 72)}…`),
    };
  });
  process.stdout.write(`  ${label}: ${state.total} image(s), ${state.broken.length} broken\n`);
  for (const source of state.broken) process.stdout.write(`    broken: ${source}\n`);
  if (state.broken.length > 0) {
    throw new Error(`${state.broken.length} image(s) in the saved page did not render`);
  }
}

/**
 * Waits for the library to grow, and says what the popup said if it does not.
 * A capture that fails leaves its reason in the status line, which is a great deal
 * more useful than a timeout.
 */
async function waitForSave(popup, before, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const packs = await library(popup);
    if (packs.length > before) return packs;
    await wait(400);
  }
  const status = await popup.locator('#save-status').textContent();
  throw new Error(`the save never reached the library. The popup says: ${status || '(nothing)'}`);
}

/** `DEPTH_LABELS` in `popup.js`, which is what the collapsed Options row shows. */
const DEPTH_LABELS = ['Single page', 'One level of links', 'Two levels of links', 'Three levels of links'];

/**
 * Sets how far the save follows links, through the disclosure that holds the
 * control — and closes it again, because the extension remembers the setting and
 * an Options panel left hanging open is height the progress card needs.
 */
async function setDepth(popup, depth) {
  if ((await popup.locator('#options-summary').textContent()) === DEPTH_LABELS[depth]) return;
  await popup.click('.disclosure > summary');
  await popup.selectOption('#depth-select', String(depth));
  await popup.waitForFunction(
    (label) => document.getElementById('options-summary')?.textContent === label,
    DEPTH_LABELS[depth],
    { timeout: 10000 },
  );
  await popup.click('.disclosure > summary');
}

/**
 * Saves a page through the popup, and waits for the extension to say it is done.
 * `onProgress` is handed the popup and the tab while the capture is still running,
 * which is how the first screenshot is taken.
 */
async function savePage(context, extensionId, tab, url, { depth = 0, folder = 'Library', onProgress = null } = {}) {
  await tab.goto(url, { waitUntil: 'load' });
  const popup = await openPopup(context, extensionId, url);
  await chooseFolder(popup, folder);
  await setDepth(popup, depth);
  const before = (await library(popup)).length;
  await popup.click('#save-button');
  if (onProgress) await onProgress(popup, tab);
  // Polled from here rather than with `waitForFunction`, because the question is
  // asked over extension messaging and so can only be answered asynchronously.
  const [saved] = await waitForSave(popup, before);
  await popup.close();
  process.stdout.write(
    `  saved "${saved.title}" — ${saved.stats.pages} page(s), ${saved.stats.resources} file(s), ${saved.stats.failed} issue(s)\n`,
  );
  return saved;
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  if (!existsSync(path.join(dist, 'manifest.json'))) {
    process.stderr.write('dist/manifest.json is missing. Run `npm run build` first.\n');
    process.exit(1);
  }
  const icon = path.join(dist, 'icons', 'icon-128.png');
  if (!existsSync(icon)) {
    process.stderr.write(`${path.relative(root, icon)} is missing. Run \`npm run build\` first.\n`);
    process.exit(1);
  }
  mkdirSync(out, { recursive: true });

  const site = await startSite();
  process.stdout.write(`  stand-in publication on ${site.origin} (127.0.0.1:${site.port})\n`);
  const profile = mkdtempSync(path.join(tmpdir(), 'pagepack-store-'));
  const context = await playwright.chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: WIDTH, height: STAGE },
    colorScheme: 'light',
    // Turns off the indeterminate bar's slide, the reader's floating loader and the
    // popup's switch transitions, so nothing is caught halfway through one.
    reducedMotion: 'reduce',
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      // The stand-in publication, and nothing else. The second pair of rules keeps
      // the plan line off a payment provider's opinion of today: `getProviderStatus`
      // already treats an unreachable provider as "unknown", which the popup renders
      // as a sentence rather than a price, and this run has no business contacting
      // one anyway.
      `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${site.port},` +
        'MAP extensionpay.com ~NOTFOUND,MAP *.extensionpay.com ~NOTFOUND',
      // Chrome tries HTTPS first on a typed http:// navigation and falls back. The
      // fallback works, and waiting for it on every page load of a plain local
      // server is a second a page for nothing.
      '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable',
    ],
  });

  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).hostname;
  process.stdout.write(`  extension id ${extensionId}\n`);

  const tab = await context.newPage();
  await tab.setViewportSize({ width: WIDTH, height: STAGE });
  await tab.goto(`${site.origin}/`, { waitUntil: 'load' });

  /* --- the library, filled by using the extension -------------------------- */
  const setup = await openPopup(context, extensionId, `${site.origin}/`);
  for (const name of ['Trip planning', 'Field notes']) {
    await createFolder(setup, name);
    process.stdout.write(`  folder created: ${name}\n`);
  }
  await setup.close();

  /**
   * Eight saves, filed where they are for a reason. Three stay at the top level, so
   * the library panel comes out at five rows — two folders and three items — which
   * is what the popup's list holds without slicing a sixth in half. Those three are
   * also the ones the search panel finds, because a search only looks in the folder
   * you are standing in. The five-page item gets a folder to itself for the same
   * kind of reason: with anything beside it, its page list runs off the bottom.
   */
  await savePage(context, extensionId, tab, `${site.origin}/boots`);
  await savePage(context, extensionId, tab, `${site.origin}/tea`);
  await savePage(context, extensionId, tab, `${site.origin}/weather`, { folder: 'Field notes' });
  await savePage(context, extensionId, tab, `${site.origin}/water`, { folder: 'Field notes' });
  await savePage(context, extensionId, tab, `${site.origin}/repairs`, { folder: 'Field notes' });
  await savePage(context, extensionId, tab, `${site.origin}/packing`, { folder: 'Field notes' });

  /* --- 01: a capture actually in flight ----------------------------------- */
  /**
   * The assets on this page are answered slowly, and the script waits for the
   * extension's own bar to pass a third of the way before shooting. The band is
   * wide because the exact moment depends on how fast this machine is; the numbers
   * that end up in the picture are read back out of the popup and printed below.
   */
  site.state.assetDelay = 620;
  let progressShot = null;
  let savingPageShot = null;
  let progressReport = {};
  await savePage(context, extensionId, tab, `${site.origin}/maps`, {
    async onProgress(popup, saving) {
      await popup.waitForSelector('#save-progress:not([hidden])', { timeout: 30000 });
      await popup.waitForFunction(
        () => {
          const fill = document.getElementById('progress-fill');
          const width = Number.parseFloat(fill?.style.width || '0');
          return width >= 34 && width <= 72;
        },
        null,
        { timeout: 60000, polling: 80 },
      );
      progressReport = await popup.evaluate(() => ({
        detail: document.getElementById('progress-detail').textContent,
        fill: document.getElementById('progress-fill').style.width,
        title: document.getElementById('progress-title').textContent,
      }));
      progressShot = await popup.screenshot();
      // The same moment, one surface each: the page being read and the popup
      // reporting on it. Taken while the fetching is still going on.
      savingPageShot = await saving.screenshot();
    },
  });
  site.state.assetDelay = 0;
  process.stdout.write(
    `  popup reported: ${progressReport.title} — ${progressReport.detail} (bar at ${progressReport.fill})\n`,
  );

  /* --- the multi-page item, saved last so its pages win the URL index ----- */
  /**
   * Depth 1 from the front page, which links to four others on the same site, so
   * this one item holds five pages. Saved last on purpose: `findSavedUrl` returns
   * the most recent match, so after this every one of those five addresses resolves
   * to this pack, which is what makes the offline redirect land on a page with
   * somewhere to go next rather than on the single-page copy of it.
   */
  const traverse = await savePage(context, extensionId, tab, `${site.origin}/`, {
    depth: 1,
    folder: 'Trip planning',
  });

  /* --- 02: the library, in three real states ------------------------------ */
  const libraryPopup = await openPopup(context, extensionId, `${site.origin}/`);
  await libraryPopup.click('#library-tab');
  await libraryPopup.waitForSelector('.folder-entry');
  await wait(400);
  const libraryRoot = await libraryPopup.screenshot();

  await libraryPopup.click('.folder-entry:has-text("Trip planning") .entry-open');
  await libraryPopup.waitForFunction(
    () => document.getElementById('library-title')?.textContent === 'Trip planning',
  );
  // The item's own ⋯ menu, and its own "Show 5 pages" entry.
  await libraryPopup.click(`.entry[data-item-id="${traverse.id}"] .entry-menu`);
  await libraryPopup.click(`#row-menu .menu-item:has-text("Show ${traverse.stats.pages} pages")`);
  await libraryPopup.waitForSelector(`#pages-${traverse.id}`);
  await wait(400);
  const libraryFolder = await libraryPopup.screenshot();

  /**
   * "ford" is not in the title, the address or the folder name of anything. It is a
   * word in the body of three of the saved pages, so the only way these rows can be
   * on screen is the captured text — which is the claim the panel is there to make.
   *
   * Searched at the top level on purpose: the extension scopes a search to the
   * folder you are standing in, so this has to be somewhere those three items are
   * visible, and it is also why the six-page item does not appear here.
   */
  await libraryPopup.click('#folder-back-button');
  await libraryPopup.fill('#library-search', 'ford');
  // Full-text search is debounced, then answered by the service worker.
  await libraryPopup.waitForFunction(
    () => /match/.test(document.getElementById('library-count')?.textContent || ''),
    null,
    { timeout: 15000 },
  );
  await wait(500);
  const searchReport = await libraryPopup.evaluate(() => ({
    count: document.getElementById('library-count').textContent,
    rows: [...document.querySelectorAll('#library-list .entry-title')].map((node) => node.textContent),
  }));
  const librarySearch = await libraryPopup.screenshot();
  await libraryPopup.close();
  process.stdout.write(`  search "ford" -> ${searchReport.count}: ${searchReport.rows.join(' / ')}\n`);

  /* --- 03: the reader ----------------------------------------------------- */
  const reader = await context.newPage();
  await reader.setViewportSize({ width: WIDTH, height: STAGE });
  await reader.goto(`chrome-extension://${extensionId}/viewer.html?pack=${traverse.id}&page=0`);
  await reader.waitForSelector('#reader-main:not([hidden])', { timeout: 30000 });
  // The saved page is rendered in a sandboxed frame, so the reader cannot see into
  // it — `contentDocument` is null from the extension page, which is the sandbox
  // doing its job. Playwright can still attach to the frame and count the links the
  // reader marked before handing the markup over.
  const opaque = await reader.evaluate(() => document.getElementById('reader-frame').contentDocument === null);
  const marked = await savedLinkCount(reader);
  process.stdout.write(
    `  reader: ${marked} link(s) marked "Saved"; the frame is ${opaque ? 'opaque to the extension page' : 'READABLE — check the sandbox'}\n`,
  );
  await reportImages(reader, 'reader');
  await wait(700);
  const readerShot = await reader.screenshot();
  await reader.close();

  /* --- 04: offline, for real ---------------------------------------------- */
  /**
   * Not a depiction. `setOffline` puts Chromium's network stack into the state a
   * pulled cable produces, and the local server that fed every capture above
   * becomes as unreachable as anything else — which is checked below on an address
   * PagePack has never seen, and fails with ERR_INTERNET_DISCONNECTED.
   */
  await context.setOffline(true);
  const probe = await context.newPage();
  const reachable = await probe
    .goto(`${site.origin}/never-saved`, { timeout: 15000 })
    .then(() => 'the page loaded — the network is NOT off')
    .catch((error) => String(error.message).split('\n')[0].replace(/^page\.goto:\s*/, ''));
  await probe.close();
  process.stdout.write(`  network switched off; ${site.origin}/never-saved -> ${reachable}\n`);
  if (!/ERR_INTERNET_DISCONNECTED/.test(reachable)) {
    throw new Error(`the offline shot needs the network to be off, and it is not: ${reachable}`);
  }

  const offlineRead = await context.newPage();
  await offlineRead.setViewportSize(READER_PANEL);
  const failedUrl = `${site.origin}/packing`;
  await offlineRead.goto(failedUrl).catch(() => {});
  /**
   * The service worker sees that navigation fail, looks the address up in the local
   * index and sends the tab to the reader instead. Watched by polling the tab's
   * address rather than with `waitForURL`, because the extension's redirect cancels
   * the navigation that is still pending and that arrives as an aborted-load error
   * on whichever wait happens to be outstanding.
   */
  const redirected = Date.now() + 30000;
  while (!/viewer\.html\?pack=/.test(offlineRead.url()) && Date.now() < redirected) await wait(250);
  if (!/viewer\.html\?pack=/.test(offlineRead.url())) {
    throw new Error(`offline, ${failedUrl} was not redirected to the reader (still ${offlineRead.url()})`);
  }
  await offlineRead.waitForSelector('#reader-main:not([hidden])', { timeout: 30000 });
  await wait(900);
  const offlineReport = await offlineRead.evaluate(() => ({
    url: location.href,
    title: document.getElementById('reader-title').textContent,
    page: document.getElementById('reader-page-label').textContent,
  }));
  await reportImages(offlineRead, 'offline reader');
  const offlineShot = await offlineRead.screenshot();
  await offlineRead.close();
  process.stdout.write(
    `  offline: ${failedUrl} -> ${offlineReport.title}, page ${offlineReport.page}\n` +
      `           ${offlineReport.url}\n`,
  );

  /**
   * The popup, in the same browser, describing the same situation in its own words.
   *
   * Playwright's own offline switch does not reach an extension page's
   * `navigator.onLine`, so the same emulation is applied to this target directly.
   * It is the one question the popup asks (`isOffline` in `popup.js`), and the
   * answer has to be the true one: if it comes back online this throws rather than
   * photographing a popup that says the network is fine while it is not.
   */
  const offlinePopup = await openPopup(context, extensionId, `${site.origin}/`);
  const session = await context.newCDPSession(offlinePopup);
  await session.send('Network.enable');
  await session.send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await offlinePopup.waitForFunction(() => navigator.onLine === false, null, { timeout: 10000 });
  // Going offline sends the popup to the Library by itself (`applyOnlineState` in
  // `popup.js`), which is the sensible thing to show somebody with no connection and
  // is also the panel the library screenshot already is. Back on the Save tab it
  // says what it will not do, in its own words, which is the picture worth having.
  await offlinePopup.click('#save-tab');
  await wait(600);
  const popupOffline = await offlinePopup.evaluate(() => ({
    online: navigator.onLine,
    button: document.getElementById('save-button').textContent,
    disabled: document.getElementById('save-button').disabled,
  }));
  if (popupOffline.online !== false) throw new Error('the popup still believes it is online');
  const offlinePopupShot = await offlinePopup.screenshot();
  await offlinePopup.close();
  process.stdout.write(
    `  popup offline: save button reads "${popupOffline.button}", disabled=${popupOffline.disabled}\n`,
  );

  await context.setOffline(false);
  await tab.close();

  /* --- compose ------------------------------------------------------------ */
  await shoot(
    context,
    '01-save-1280x800.png',
    frame({
      eyebrow: 'PagePack &middot; Saving a page',
      title: 'One click, and the whole page comes with it.',
      note: 'Styles, images and fonts are fetched and written to this device while you watch, with the file count and a cancel button in view. Close the window if you like — the save carries on in the background.',
      body: `<img class="page" src="${dataUrl(savingPageShot)}" alt="">` +
        `<img class="popup" src="${dataUrl(progressShot)}" alt="">`,
    }),
  );

  await shoot(
    context,
    '02-library-1280x800.png',
    frame({
      eyebrow: 'PagePack &middot; Your library',
      title: 'Folders you made, and search that reads the page.',
      note: 'Saved items are filed where you put them, reordered by pointer or keyboard, and searched by the text captured inside them rather than the title alone. None of it needs a connection.',
      body:
        '<div class="cards">' +
        `<div class="col"><p class="lab">The library</p><img src="${dataUrl(libraryRoot)}" alt=""></div>` +
        `<div class="col"><p class="lab">A folder, and the pages inside one save</p><img src="${dataUrl(libraryFolder)}" alt=""></div>` +
        `<div class="col"><p class="lab">Searching the captured text</p><img src="${dataUrl(librarySearch)}" alt=""></div>` +
        '</div>',
      stampAt: 'below',
    }),
  );

  await shoot(
    context,
    '03-reader-1280x800.png',
    frame({
      eyebrow: 'PagePack &middot; The reader',
      title: 'Read it back, and keep following the links.',
      note: 'Saved pages open in a sandboxed reader that cannot reach your cookies, PagePack’s own data or the network. Links to other pages in the same save are marked ✓ Saved and open from disk; the live page stays one click away.',
      body: `<img class="page" src="${dataUrl(readerShot)}" alt="">`,
    }),
  );

  await shoot(
    context,
    '04-offline-1280x800.png',
    frame({
      eyebrow: 'PagePack &middot; With no connection',
      title: 'The network is gone. The reading is not.',
      note: 'Chromium’s network was switched off before both of these. Following a saved address then failed at the network, so PagePack recognised it and opened the copy held on this device — at the page that was asked for, with the rest of the save still to hand.',
      body:
        '<div class="cards">' +
        `<div class="col"><p class="lab">Nothing new can be saved, and it says so</p><img src="${dataUrl(offlinePopupShot)}" alt=""></div>` +
        `<div class="col"><p class="lab is-on">The address that just failed, opened from this device</p><img src="${dataUrl(offlineShot)}" alt=""></div>` +
        '</div>',
      stampAt: 'below',
    }),
  );

  await shoot(context, 'promo-440x280.png', tile(fileUrl(icon)), TILE);

  await context.close();
  site.server.close();
  // Windows keeps a handle on Crashpad files for a moment after the browser exits,
  // so a failed profile cleanup must not fail the build.
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    process.stdout.write(`  (left ${profile} behind: ${error.code ?? error.message})\n`);
  }

  /* --- verify ------------------------------------------------------------- */
  const expected = [
    ['01-save-1280x800.png', WIDTH, HEIGHT],
    ['02-library-1280x800.png', WIDTH, HEIGHT],
    ['03-reader-1280x800.png', WIDTH, HEIGHT],
    ['04-offline-1280x800.png', WIDTH, HEIGHT],
    ['promo-440x280.png', TILE.width, TILE.height],
  ];
  let bad = 0;
  for (const [name, width, height] of expected) {
    const size = pngSize(path.join(out, name));
    const ok = size.width === width && size.height === height;
    if (!ok) bad += 1;
    process.stdout.write(
      `  ${ok ? 'ok   ' : 'WRONG'} ${name}: ${size.width}x${size.height}` +
        (ok ? '\n' : ` (expected ${width}x${height})\n`),
    );
  }
  if (bad > 0) {
    process.stderr.write(`${bad} file(s) are not the size the store requires.\n`);
    process.exit(1);
  }
  process.stdout.write(`store assets in ${path.relative(root, out)}\n`);
}

await main();
