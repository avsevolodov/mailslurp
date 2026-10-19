using System.Net;
using System.Text;
using System.Text.Json;
using PreviewLab;

var passed = 0;
await Run("Validates target selection and HTML", () =>
{
    Check(PreviewTargets.Validate(new PreviewRequest("Test", "<h1>Hello</h1>",
        ["gmail_chromium_web"])).Subject == "Test", "valid request");
    try
    {
        PreviewTargets.Validate(new PreviewRequest("x", "x", ["unknown-client"]));
        throw new Exception("invalid target accepted");
    }
    catch (PreviewException ex) when (ex.StatusCode == 400) { }
    return Task.CompletedTask;
});

await Run("Starts preview using MailSlurp's email and run APIs", async () =>
{
    var inboxId = Guid.NewGuid();
    var emailId = Guid.NewGuid();
    var runId = Guid.NewGuid();
    var requests = new List<(string Path, string Method, string? Content, bool HasKey)>();
    var responses = new Queue<HttpResponseMessage>([
        Json(new { id = inboxId, emailAddress = "qa@example.test" }),
        new HttpResponseMessage(HttpStatusCode.NoContent),
        Json(new { id = emailId }),
        Json(new { run = new { runId } })
    ]);
    Environment.SetEnvironmentVariable("MAILSLURP_API_KEY", "test-secret");
    using var http = new HttpClient(new StubHandler(req =>
    {
        requests.Add((req.RequestUri!.PathAndQuery, req.Method.Method,
            req.Content?.ReadAsStringAsync().GetAwaiter().GetResult(),
            req.Headers.TryGetValues("x-api-key", out var header) &&
            header.Single() == "test-secret"));
        return responses.Dequeue();
    }));
    var client = new MailSlurpApi(http);
    var started = await client.StartAsync(new PreviewRequest("Test", "<h1>Hi</h1>",
        ["gmail_chromium_web"]), CancellationToken.None);
    Check(started.RunId == runId && started.EmailId == emailId,
        "returned correct identifiers");
    Check(requests.Count == 4, "expected 4 provider requests");
    Check(requests.All(r => r.HasKey), "x-api-key only on server-side requests");
    Check(requests[0].Path == "/inboxes/withOptions", "create inbox");
    Check(requests[1].Path == $"/inboxes/{inboxId}", "send email");
    Check(requests[2].Path.StartsWith("/waitForLatestEmail?inboxId="), "wait email");
    Check(requests[3].Path == $"/emails/{emailId}/device-previews", "render email");
    using var body = JsonDocument.Parse(requests[3].Content!);
    Check(body.RootElement.GetProperty("targets")[0].GetString() ==
        "gmail_chromium_web", "targets must use documented REST field");
});

await Run("Normalizes target progress and private screenshot URLs", () =>
{
    var runId = Guid.NewGuid();
    var screenshotId = Guid.NewGuid();
    using var json = JsonDocument.Parse(
        $$"""
        {"run":{"status":"COMPLETED"},
          "targets":[{"id":"target-one","name":"Gmail","status":"COMPLETED"}],
          "screenshots":[{"screenshotId":"{{screenshotId}}","targetId":"target-one",
            "accessUrl":"https://provider.example/private-image"}]}
        """);
    var output = ResultNormalizer.Normalize(runId, json.RootElement);
    Check(output.Status == "COMPLETED", "status");
    Check(output.Targets[0].Name == "Gmail", "target mapping");
    Check(output.Screenshots[0].ImageUrl ==
        $"/api/runs/{runId}/screenshots/{screenshotId}", "private image proxy URL");
    Check(output.Screenshots[0].Title == "Gmail", "image title");
});

await Run("Screenshot access is scoped to run and provider results", () =>
{
    var store = new RunStore();
    var runId = Guid.NewGuid();
    var shotId = Guid.NewGuid();
    Check(!store.Exists(runId), "missing run");
    store.Add(runId);
    Check(!store.AllowsScreenshot(runId, shotId), "cannot access unchecked screenshot");
    store.MarkScreenshots(runId, [shotId]);
    Check(store.AllowsScreenshot(runId, shotId), "allowed image");
    Check(!store.AllowsScreenshot(Guid.NewGuid(), shotId), "other run blocked");
});

await Run("Provider errors never expose secret response bodies", async () =>
{
    Environment.SetEnvironmentVariable("MAILSLURP_API_KEY", "test-secret");
    using var http = new HttpClient(new StubHandler(_ =>
        new HttpResponseMessage(HttpStatusCode.Forbidden) {
            Content = new StringContent("secret upstream trace")
        }));
    var client = new MailSlurpApi(http);
    try
    {
        await client.StartAsync(new PreviewRequest("T", "HTML",
            ["gmail_chromium_web"]), CancellationToken.None);
        throw new Exception("expected provider error");
    }
    catch (PreviewException ex)
    {
        Check(ex.StatusCode == 502, "error response code");
        Check(!ex.Message.Contains("trace"), "no upstream trace leaked");
    }
});

Console.WriteLine($"All {passed} tests passed.");

async Task Run(string title, Func<Task> check)
{
    await check();
    passed++;
    Console.WriteLine($"PASS: {title}");
}

static HttpResponseMessage Json(object data) => new(HttpStatusCode.OK)
{
    Content = new StringContent(JsonSerializer.Serialize(data),
        Encoding.UTF8, "application/json")
};

static void Check(bool condition, string message)
{
    if (!condition) throw new Exception($"Assertion failed: {message}");
}

sealed class StubHandler(Func<HttpRequestMessage, HttpResponseMessage> callback)
    : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken) =>
        Task.FromResult(callback(request));
}
