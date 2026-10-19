using System.Collections.Concurrent;
using System.Text.Json;

namespace PreviewLab;

public sealed record PreviewRequest(string? Subject, string? Html, List<string>? Targets);
public sealed record PreviewStarted(Guid RunId, string InboxAddress, Guid EmailId);
public sealed record PreviewTarget(string Id, string Title, string Platform);
public sealed record TargetResult(string Id, string Name, string Status, string? Error);
public sealed record ScreenshotResult(Guid Id, string Title, string Status, string ImageUrl);
public sealed record PreviewResult(Guid RunId, string Status, List<TargetResult> Targets, List<ScreenshotResult> Screenshots);

public sealed class PreviewException(int statusCode, string message) : Exception(message)
{
    public int StatusCode { get; } = statusCode;
}

public static class PreviewTargets
{
    public static readonly PreviewTarget[] All =
    [
        new("gmail_chromium_web", "Gmail Web", "Desktop"),
        new("outlook_classic_windows", "Outlook Classic", "Windows"),
        new("outlook_chromium_web", "Outlook Web", "Desktop"),
        new("ios_mail_physical_device", "Apple Mail", "iPhone"),
        new("gmail_android_emulator", "Gmail", "Android"),
        new("outlook_new_windows", "New Outlook", "Windows")
    ];

    public static PreviewRequest Validate(PreviewRequest? request)
    {
        if (request?.Subject is not { Length: > 0 and <= 200 } subject ||
            string.IsNullOrWhiteSpace(subject))
            throw new PreviewException(400, "Subject must be 1–200 characters.");
        if (request.Html is not { Length: > 0 and <= 120000 } html ||
            string.IsNullOrWhiteSpace(html))
            throw new PreviewException(400, "HTML must be 1–120,000 characters.");

        var requestedTargets = request.Targets;
        if (requestedTargets is null || requestedTargets.Count is < 1 or > 6 ||
            requestedTargets.Distinct(StringComparer.Ordinal).Count() != requestedTargets.Count ||
            requestedTargets.Any(id => !All.Any(t => t.Id == id)))
            throw new PreviewException(400, "Choose 1–6 supported email clients.");

        return request with { Subject = subject.Trim() };
    }
}

public static class JsonFields
{
    public static JsonElement Field(JsonElement value, string key) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(key, out var result)
            ? result : default;

    public static string? Text(JsonElement value, params string[] names)
    {
        foreach (var name in names)
        {
            var found = Field(value, name);
            if (found.ValueKind == JsonValueKind.String)
                return found.GetString();
        }
        return null;
    }

    public static Guid RequireGuid(JsonElement value, params string[] names)
    {
        var text = Text(value, names);
        if (!Guid.TryParse(text, out var parsed))
            throw new PreviewException(502, "MailSlurp returned an invalid identifier.");
        return parsed;
    }

    public static JsonElement[] Array(JsonElement value, string name)
    {
        var element = Field(value, name);
        return element.ValueKind == JsonValueKind.Array
            ? element.EnumerateArray().ToArray()
            : [];
    }
}

public static class ResultNormalizer
{
    public static PreviewResult Normalize(Guid runId, JsonElement payload)
    {
        var run = JsonFields.Field(payload, "run");
        var status = JsonFields.Text(run, "status") ??
                     JsonFields.Text(payload, "status") ?? "PENDING";

        var sourceTargets = JsonFields.Array(payload, "targets");
        var targets = sourceTargets.Select(target => new TargetResult(
            JsonFields.Text(target, "id", "targetId", "targetKey") ?? "",
            JsonFields.Text(target, "displayName", "name", "targetKey", "provider") ?? "Email client",
            JsonFields.Text(target, "status") ?? "PENDING",
            JsonFields.Text(target, "errorMessage"))).ToList();

        var targetNames = sourceTargets
            .Select((target, i) => new {
                Key = JsonFields.Text(target, "id", "targetId", "targetKey"),
                Name = targets[i].Name
            })
            .Where(x => x.Key is not null)
            .ToDictionary(x => x.Key!, x => x.Name, StringComparer.Ordinal);

        var screenshots = new List<ScreenshotResult>();
        foreach (var screenshot in JsonFields.Array(payload, "screenshots"))
        {
            if (!Guid.TryParse(JsonFields.Text(screenshot, "screenshotId", "id"), out var id))
                continue;

            var targetId = JsonFields.Text(screenshot, "targetId");
            var title = JsonFields.Text(screenshot, "displayName", "targetName", "targetKey") ??
                (targetId is not null && targetNames.TryGetValue(targetId, out var name)
                    ? name : "Email preview");
            screenshots.Add(new ScreenshotResult(
                id, title,
                JsonFields.Text(screenshot, "status") ?? "COMPLETED",
                $"/api/runs/{runId}/screenshots/{id}"));
        }
        return new PreviewResult(runId, status, targets, screenshots);
    }
}

public sealed class RunStore
{
    private sealed class RunRecord
    {
        public DateTimeOffset CreatedAt { get; } = DateTimeOffset.UtcNow;
        public ConcurrentDictionary<Guid, byte> ScreenshotIds { get; } = new();
    }

    private readonly ConcurrentDictionary<Guid, RunRecord> _runs = new();
    private static readonly TimeSpan Lifetime = TimeSpan.FromHours(12);

    public void Add(Guid id) => _runs[id] = new RunRecord();

    public bool Exists(Guid id)
    {
        if (!_runs.TryGetValue(id, out var record)) return false;
        if (DateTimeOffset.UtcNow - record.CreatedAt < Lifetime) return true;
        _runs.TryRemove(id, out _);
        return false;
    }

    public void MarkScreenshots(Guid runId, IEnumerable<Guid> ids)
    {
        if (!_runs.TryGetValue(runId, out var record)) return;
        foreach (var id in ids) record.ScreenshotIds.TryAdd(id, 0);
    }

    public bool AllowsScreenshot(Guid runId, Guid screenshotId) =>
        Exists(runId) && _runs.TryGetValue(runId, out var record) &&
        record.ScreenshotIds.ContainsKey(screenshotId);
}
