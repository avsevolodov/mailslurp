using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace PreviewLab;

public sealed class MailSlurpApi
{
    private const int MaxImageSize = 20 * 1024 * 1024;
    private readonly HttpClient _http;
    public bool IsConfigured { get; }

    public MailSlurpApi(HttpClient client)
    {
        _http = client;
        _http.BaseAddress ??= new Uri("https://api.mailslurp.com/");
        _http.Timeout = TimeSpan.FromSeconds(90);
        var key = Environment.GetEnvironmentVariable("MAILSLURP_API_KEY");
        IsConfigured = !string.IsNullOrWhiteSpace(key);
        if (IsConfigured) _http.DefaultRequestHeaders.TryAddWithoutValidation("x-api-key", key);
        _http.DefaultRequestHeaders.Accept.Add(
            new MediaTypeWithQualityHeaderValue("application/json"));
    }

    private async Task<JsonElement> JsonAsync(
        HttpMethod method, string path, object? body, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(method, path);
        if (body is not null) request.Content = JsonContent.Create(body);
        using var response = await _http.SendAsync(
            request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode)
            throw new PreviewException(502, $"MailSlurp API returned HTTP {(int)response.StatusCode}.");

        if (response.Content.Headers.ContentLength == 0 ||
            response.StatusCode == System.Net.HttpStatusCode.NoContent)
            return default;

        var content = await response.Content.ReadAsStringAsync(ct);
        if (string.IsNullOrWhiteSpace(content)) return default;
        using var json = JsonDocument.Parse(content);
        return json.RootElement.Clone();
    }

    public async Task<PreviewStarted> StartAsync(PreviewRequest request, CancellationToken ct)
    {
        if (!IsConfigured)
            throw new PreviewException(503, "Set MAILSLURP_API_KEY on the server.");

        var inbox = await JsonAsync(HttpMethod.Post, "/inboxes/withOptions",
            new { name = $"preview-lab-{Guid.NewGuid():N}", expiresIn = 300000 }, ct);
        var inboxId = JsonFields.RequireGuid(inbox, "id");
        var address = JsonFields.Text(inbox, "emailAddress");
        if (string.IsNullOrWhiteSpace(address))
            throw new PreviewException(502, "MailSlurp did not return an inbox address.");

        await JsonAsync(HttpMethod.Post, $"/inboxes/{inboxId}",
            new { to = new[] { address }, subject = request.Subject,
                  body = request.Html, isHTML = true }, ct);

        var email = await JsonAsync(HttpMethod.Get,
            $"/waitForLatestEmail?inboxId={inboxId}&timeout=60000&unreadOnly=true",
            null, ct);
        var emailId = JsonFields.RequireGuid(email, "id");

        // The public REST API accepts 'targets' for native device identifiers.
        var run = await JsonAsync(HttpMethod.Post,
            $"/emails/{emailId}/device-previews",
            new { targets = request.Targets }, ct);
        var runObject = JsonFields.Field(run, "run");
        var runId = JsonFields.Text(runObject, "runId") ??
                    JsonFields.Text(run, "runId", "id");
        if (!Guid.TryParse(runId, out var runGuid))
            throw new PreviewException(502, "MailSlurp did not return a preview run ID.");

        return new PreviewStarted(runGuid, address, emailId);
    }

    public Task<JsonElement> GetResultsAsync(Guid runId, CancellationToken ct) =>
        JsonAsync(HttpMethod.Get,
            $"/emails/device-previews/{runId}/results", null, ct);

    public async Task<(byte[] Image, string ContentType)> GetScreenshotAsync(
        Guid runId, Guid screenshotId, CancellationToken ct)
    {
        if (!IsConfigured)
            throw new PreviewException(503, "Set MAILSLURP_API_KEY on the server.");
        using var request = new HttpRequestMessage(HttpMethod.Get,
            $"/emails/device-previews/{runId}/screenshots/{screenshotId}/image");
        using var response = await _http.SendAsync(
            request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode)
            throw new PreviewException(502, $"MailSlurp API returned HTTP {(int)response.StatusCode}.");

        var type = response.Content.Headers.ContentType?.MediaType ?? "";
        if (type is not ("image/png" or "image/jpeg" or "application/octet-stream"))
            throw new PreviewException(502, "MailSlurp did not return an image.");
        if (response.Content.Headers.ContentLength > MaxImageSize)
            throw new PreviewException(502, "MailSlurp screenshot exceeds 20 MB.");

        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var buffer = new MemoryStream();
        var chunk = new byte[65536];
        int count;
        while ((count = await stream.ReadAsync(chunk, ct)) > 0)
        {
            if (buffer.Length + count > MaxImageSize)
                throw new PreviewException(502, "MailSlurp screenshot exceeds 20 MB.");
            await buffer.WriteAsync(chunk.AsMemory(0, count), ct);
        }
        return (buffer.ToArray(), type == "image/jpeg" ? "image/jpeg" : "image/png");
    }
}
