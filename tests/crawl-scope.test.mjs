/**
 * What counts as "the same site".
 *
 * `siteKey` decides when a save stops following links. Getting it wrong in the
 * permissive direction is not a tidiness problem: every GitHub Pages site used to
 * key to `github.io`, so a save that followed links from one person's site walked
 * straight into other people's — collecting pages the user never asked for, from
 * sites they had never visited, and charging them against the page allowance.
 *
 * The list behind this is a curated subset of the Public Suffix List rather than
 * the list itself; see the comment on `MULTI_LABEL_SUFFIXES` in `background.js`
 * for why. These assertions are the cases that subset exists for.
 */
import assert from "node:assert/strict";

const chromeStub = new Proxy(function () {}, {
  get: (target, property) => (property === "lastError" || property === "then" ? undefined : chromeStub),
  apply: () => undefined,
});
globalThis.chrome = chromeStub;

const { siteKey } = await import("../background.js");

const sameSite = (a, b) => siteKey(a) === siteKey(b);

/* ------------------------------------------------------------------ *
 * Subdomains of one site are the same site
 * ------------------------------------------------------------------ */

assert.ok(sameSite("example.com", "www.example.com"));
assert.ok(sameSite("example.com", "blog.example.com"));
assert.ok(sameSite("docs.example.com", "api.example.com"));
assert.ok(sameSite("example.co.uk", "www.example.co.uk"));

/* ------------------------------------------------------------------ *
 * Different registrations are different sites
 * ------------------------------------------------------------------ */

assert.ok(!sameSite("example.com", "example.org"));
assert.ok(!sameSite("example.com", "notexample.com"));
assert.ok(!sameSite("example.co.uk", "other.co.uk"), "two unrelated UK companies are not one site");
assert.ok(!sameSite("example.co.za", "other.co.za"), "co.za was missing and made every South African site one site");
assert.ok(!sameSite("example.com.br", "other.com.br"));

/* ------------------------------------------------------------------ *
 * Hosting platforms: one subdomain, one owner
 * ------------------------------------------------------------------ */

// The case this list was written for.
assert.ok(!sameSite("alice.github.io", "bob.github.io"), "a crawl of one GitHub Pages site must not reach another");
assert.ok(sameSite("alice.github.io", "alice.github.io"));
assert.ok(sameSite("alice.github.io", "www.alice.github.io"), "a subdomain of one owner's site is still theirs");

for (const host of ["blogspot.com", "wordpress.com", "vercel.app", "netlify.app", "herokuapp.com", "pages.dev", "substack.com", "itch.io", "myshopify.com"]) {
  assert.ok(!sameSite(`alice.${host}`, `bob.${host}`), `two sites on ${host} are treated as one`);
}

// A three-label suffix has to beat the two-label one inside it.
assert.ok(!sameSite("one.s3.amazonaws.com", "two.s3.amazonaws.com"), "two S3 buckets are not one site");

/* ------------------------------------------------------------------ *
 * Degenerate input does not throw
 * ------------------------------------------------------------------ */

assert.equal(siteKey(""), "");
assert.equal(siteKey(undefined), "");
assert.equal(siteKey("localhost"), "localhost");
assert.equal(siteKey("example.com"), "example.com");
assert.equal(siteKey("EXAMPLE.COM"), "example.com", "hostnames are compared case-insensitively");

console.log("Crawl scope tests passed");
