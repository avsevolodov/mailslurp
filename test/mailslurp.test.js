import test from "node:test";
import assert from "node:assert/strict";
import { MailSlurpClient, MailSlurpError } from "../src/mailslurp.js";

const INBOX = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EMAIL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

test("sends HTML to a new inbox, waits for delivery, starts a target preview", async () => {
  const calls = [];
  const responses = [
    Response.json({ id: INBOX, emailAddress: "qa@example.test" }),
    new Response(null, { status: 204 }),
    Response.json({ id: EMAIL, subject: "Subject" }),
    Response.json({ runId: RUN }),
  ];
  const client = new MailSlurpClient({
    apiKey: "secret-value",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return responses.shift();
    },
  });
  const result = await client.sendAndStartPreview({
    subject: "Subject", html: "<h1>Hello</h1>", targets: ["gmail_chromium_web"],
  });
  assert.deepEqual(result, { runId: RUN, inboxAddress: "qa@example.test", emailId: EMAIL });
  assert.equal(calls.length, 4);
  assert.match(calls[0].url, /\/inboxes\/withOptions$/);
  assert.equal(calls[1].url, `https://api.mailslurp.com/inboxes/${INBOX}`);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    to: ["qa@example.test"], subject: "Subject", body: "<h1>Hello</h1>", isHTML: true,
  });
  assert.match(calls[2].url, /\/waitForLatestEmail\?inboxId=/);
  assert.equal(calls[3].url, `https://api.mailslurp.com/emails/${EMAIL}/device-previews`);
  assert.deepEqual(JSON.parse(calls[3].options.body), { targets: ["gmail_chromium_web"] });
  for (const call of calls) assert.equal(call.options.headers["x-api-key"], "secret-value");
});

test("does not leak upstream responses or API credentials in errors", async () => {
  const client = new MailSlurpClient({
    apiKey: "confidential",
    fetchImpl: async () => new Response("confidential provider trace", { status: 403 }),
  });
  await assert.rejects(client.createInbox(), (error) => {
    assert.ok(error instanceof MailSlurpError);
    assert.equal(error.status, 403);
    assert.doesNotMatch(error.message, /confidential|trace/);
    return true;
  });
});

test("requires image content type for private screenshot proxy", async () => {
  const client = new MailSlurpClient({
    apiKey: "x",
    fetchImpl: async () => Response.json({ error: "not an image" }),
  });
  await assert.rejects(client.getScreenshot(RUN, EMAIL), /did not return an image/);
});
