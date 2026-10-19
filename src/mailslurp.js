/**
 * Small MailSlurp REST client. Deliberately runs on the server; no key in browser.
 * API: https://www.mailslurp.com/docs/device-renders/
 */
export class MailSlurpError extends Error {
  constructor(status) {
    super(`MailSlurp API returned HTTP ${status}.`);
    this.name = "MailSlurpError";
    this.status = status;
  }
}

export class MailSlurpClient {
  constructor({ apiKey, fetchImpl = globalThis.fetch, baseUrl = "https://api.mailslurp.com" } = {}) {
    if (!apiKey) throw new Error("MAILSLURP_API_KEY is required.");
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async request(path, { method = "GET", body, binary = false, timeoutMs = 30000 } = {}) {
    const headers = {
      "x-api-key": this.apiKey,
      Accept: binary ? "image/png, image/jpeg, application/octet-stream" : "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await this.fetchImpl(this.baseUrl + path, {
        method, headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new Error("MailSlurp request timed out.");
      }
      throw new Error("Could not connect to MailSlurp.");
    }
    if (!response.ok) throw new MailSlurpError(response.status);
    if (binary) {
      const contentType = response.headers.get("content-type") || "";
      if (!/^(image\/(png|jpeg)|application\/octet-stream)\b/i.test(contentType)) {
        throw new Error("MailSlurp did not return an image.");
      }
      const length = Number(response.headers.get("content-length") || 0);
      if (length > 20 * 1024 * 1024) throw new Error("Screenshot exceeds 20 MB.");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 20 * 1024 * 1024) throw new Error("Screenshot exceeds 20 MB.");
      return { bytes, contentType: contentType.includes("jpeg") ? "image/jpeg" : "image/png" };
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  createInbox() {
    return this.request("/inboxes/withOptions", {
      method: "POST",
      body: { name: "preview-lab-" + crypto.randomUUID().slice(0, 8),
              inboxType: "HTTP_INBOX", expiresIn: 30 * 60 * 1000 },
    });
  }

  sendEmail(inboxId, emailAddress, subject, html) {
    return this.request(`/inboxes/${encodeURIComponent(inboxId)}`, {
      method: "POST",
      body: { to: [emailAddress], subject, body: html, isHTML: true },
    });
  }

  waitForLatestEmail(inboxId) {
    const query = new URLSearchParams({
      inboxId, timeout: "60000", unreadOnly: "true",
    });
    return this.request(`/waitForLatestEmail?${query}`, { timeoutMs: 75000 });
  }

  createPreview(emailId, targets) {
    return this.request(`/emails/${encodeURIComponent(emailId)}/device-previews`, {
      method: "POST", body: { targets },
    });
  }

  getResults(runId) {
    return this.request(`/emails/device-previews/${encodeURIComponent(runId)}/results`);
  }

  getScreenshot(runId, screenshotId) {
    return this.request(`/emails/device-previews/${encodeURIComponent(runId)}/screenshots/${encodeURIComponent(screenshotId)}/image`, {
      binary: true, timeoutMs: 45000,
    });
  }

  async sendAndStartPreview({ subject, html, targets }) {
    const inbox = await this.createInbox();
    if (!inbox?.id || !inbox?.emailAddress) throw new Error("MailSlurp did not return an inbox.");
    await this.sendEmail(inbox.id, inbox.emailAddress, subject, html);
    const email = await this.waitForLatestEmail(inbox.id);
    if (!email?.id) throw new Error("MailSlurp did not receive the test email.");
    const run = await this.createPreview(email.id, targets);
    // CreateDevicePreviewRunResult typically exposes runId; tolerate nested DTOs.
    const runId = run?.runId || run?.id || run?.run?.id;
    if (!runId) throw new Error("MailSlurp did not return a device preview run ID.");
    return { runId, inboxAddress: inbox.emailAddress, emailId: email.id };
  }
}
