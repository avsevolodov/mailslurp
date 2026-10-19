import test from "node:test";
import assert from "node:assert/strict";
import { createApp, normalizeResults } from "../src/server.js";

const RUN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SHOT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const client = {
  async sendAndStartPreview() {
    return { runId: RUN, inboxAddress: "qa@example.test", emailId: "email" };
  },
  async getResults() {
    return { run: { status: "COMPLETED" }, targets: [
      { id: "t1", name: "Gmail Web", status: "COMPLETED" },
    ], screenshots: [{ screenshotId: SHOT, targetId: "t1" }] };
  },
  async getScreenshot() { return { bytes: Buffer.from("PNG"), contentType: "image/png" }; },
};

async function withServer(handler) {
  const server = createApp({ client });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await handler(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test("normalizes provider screenshots to server-only URLs", () => {
  const data = normalizeResults(RUN, {
    status: "COMPLETED",
    targets: [{ id: "t1", name: "Gmail Web", status: "COMPLETED" }],
    screenshots: [{ screenshotId: SHOT, targetId: "t1", accessUrl: "https://private.provider/path" }],
  });
  assert.equal(data.screenshots[0].imageUrl, `/api/runs/${RUN}/screenshots/${SHOT}`);
  assert.equal(data.screenshots[0].title, "Gmail Web");
});

test("rejects invalid inputs, then serves progress and authorized screenshots", async () => {
  await withServer(async (base) => {
    const invalid = await fetch(base + "/api/preview", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "x", html: "x", targets: ["unknown_client"] }),
    });
    assert.equal(invalid.status, 400);
    const unknown = await fetch(base + `/api/runs/${RUN}`);
    assert.equal(unknown.status, 404);
    const launched = await fetch(base + "/api/preview", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "Test", html: "<h1>Test</h1>", targets: ["gmail_chromium_web"] }),
    });
    assert.equal(launched.status, 201);
    assert.equal((await launched.json()).runId, RUN);
    const details = await (await fetch(base + `/api/runs/${RUN}`)).json();
    assert.equal(details.screenshots[0].id, SHOT);
    const notAllowed = await fetch(base + `/api/runs/${RUN}/screenshots/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
    assert.equal(notAllowed.status, 404);
    const image = await fetch(base + details.screenshots[0].imageUrl);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(await image.text(), "PNG");
  });
});

test("blocks cross-origin browser POSTs", async () => {
  await withServer(async (base) => {
    const res = await fetch(base + "/api/preview", {
      method: "POST", headers: { Origin: "https://untrusted.example", "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "Hi", html: "<p>Hi</p>", targets: ["gmail_chromium_web"] }),
    });
    assert.equal(res.status, 403);
  });
});
