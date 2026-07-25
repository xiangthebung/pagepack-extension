import assert from "node:assert/strict";
import {
  enqueueJourneyItem,
  journeyQueueSummary,
  pendingJourneyItems,
  removeJourneyItem,
} from "../journey-queue.js";

let journey = {
  rootUrl: "https://example.test/a#start",
  pages: [],
  captureQueue: [],
  tabState: {},
};

const first = enqueueJourneyItem(journey, {
  id: "a",
  tabId: 7,
  url: "https://example.test/a#section",
  title: "Page A",
});
assert.equal(first.queued, true);
assert.equal(first.item.parentUrl, null);
journey = first.journey;

const second = enqueueJourneyItem(journey, {
  id: "b",
  tabId: 7,
  url: "https://example.test/b",
  title: "Page B",
});
journey = second.journey;

const third = enqueueJourneyItem(journey, {
  id: "c",
  tabId: 7,
  url: "https://example.test/c",
  title: "Page C",
});
journey = third.journey;

assert.deepEqual(journey.captureQueue.map((item) => item.id), ["a", "b", "c"]);
assert.equal(second.item.parentUrl, "https://example.test/a");
assert.equal(third.item.parentUrl, "https://example.test/b");

const duplicate = enqueueJourneyItem(journey, {
  id: "duplicate-b",
  tabId: 7,
  url: "https://example.test/b#again",
});
assert.equal(duplicate.queued, false);
assert.deepEqual(duplicate.journey.captureQueue.map((item) => item.id), ["a", "b", "c"]);

journey = removeJourneyItem(journey, "a");
assert.deepEqual(journey.captureQueue.map((item) => item.id), ["b", "c"]);

journey.pages = [{ url: "https://example.test/a", title: "Saved A" }];
const summary = journeyQueueSummary(journey);
assert.equal(summary.savedCount, 1);
assert.equal(summary.queuedCount, 2);
assert.equal(summary.pageCount, 3);
assert.deepEqual(summary.pageTitles.map((page) => page.state), ["saved", "queued", "queued"]);

journey.captureQueue[0].state = "failed";
const failedSummary = journeyQueueSummary(journey);
assert.equal(failedSummary.failedCount, 1);
assert.equal(failedSummary.pendingCount, 1);
assert.deepEqual(pendingJourneyItems(journey).map((item) => item.id), ["c"]);
assert.equal(failedSummary.pageTitles[1].state, "failed");

console.log("Journey queue tests passed");
