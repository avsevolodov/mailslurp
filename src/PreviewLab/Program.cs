using PreviewLab;

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    // Static files are copied to output by the Web SDK.
    ContentRootPath = AppContext.BaseDirectory
});
builder.WebHost.ConfigureKestrel(options =>
    options.Limits.MaxRequestBodySize = 160_000);
builder.Services.AddHttpClient<MailSlurpApi>();
builder.Services.AddSingleton<RunStore>();

var app = builder.Build();

app.Use(async (context, next) =>
{
    context.Response.Headers["X-Content-Type-Options"] = "nosniff";
    context.Response.Headers["Referrer-Policy"] = "no-referrer";
    context.Response.Headers["Content-Security-Policy"] =
        "default-src 'self'; img-src 'self' data:; script-src 'self'; " +
        "style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
    context.Response.Headers["Cache-Control"] = "no-store";
    try
    {
        await next();
    }
    catch (PreviewException ex)
    {
        if (!context.Response.HasStarted)
        {
            context.Response.StatusCode = ex.StatusCode;
            await context.Response.WriteAsJsonAsync(new { error = ex.Message });
        }
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException
                             or System.Text.Json.JsonException)
    {
        if (!context.Response.HasStarted)
        {
            context.Response.StatusCode = 502;
            await context.Response.WriteAsJsonAsync(
                new { error = "MailSlurp request failed or timed out." });
        }
    }
});

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/api/health", (MailSlurpApi mail) =>
    Results.Json(new { configured = mail.IsConfigured }));

app.MapGet("/api/targets", () =>
    Results.Json(new { targets = PreviewTargets.All }));

var activeCreates = 0;
app.MapPost("/api/preview", async (
    PreviewRequest? input, HttpContext context,
    MailSlurpApi mail, RunStore store) =>
{
    if (!mail.IsConfigured)
        throw new PreviewException(503, "Set MAILSLURP_API_KEY on the server.");

    var origin = context.Request.Headers.Origin.ToString();
    var expected = $"{context.Request.Scheme}://{context.Request.Host}";
    if (!string.IsNullOrWhiteSpace(origin) &&
        !string.Equals(origin, expected, StringComparison.OrdinalIgnoreCase))
        throw new PreviewException(403, "Cross-origin requests are not allowed.");

    var validated = PreviewTargets.Validate(input);
    if (Interlocked.Increment(ref activeCreates) > 2)
    {
        Interlocked.Decrement(ref activeCreates);
        throw new PreviewException(429, "Two previews are already starting.");
    }
    try
    {
        var started = await mail.StartAsync(validated, context.RequestAborted);
        store.Add(started.RunId);
        return Results.Json(started, statusCode: 201);
    }
    finally
    {
        Interlocked.Decrement(ref activeCreates);
    }
});

app.MapGet("/api/runs/{runId:guid}", async (
    Guid runId, MailSlurpApi mail, RunStore store, CancellationToken ct) =>
{
    if (!store.Exists(runId))
        throw new PreviewException(404, "Preview not found (possibly after server restart).");
    var payload = await mail.GetResultsAsync(runId, ct);
    var normalized = ResultNormalizer.Normalize(runId, payload);
    store.MarkScreenshots(runId, normalized.Screenshots.Select(x => x.Id));
    return Results.Json(normalized);
});

app.MapGet("/api/runs/{runId:guid}/screenshots/{screenshotId:guid}", async (
    Guid runId, Guid screenshotId, MailSlurpApi mail, RunStore store,
    CancellationToken ct) =>
{
    if (!store.AllowsScreenshot(runId, screenshotId))
        throw new PreviewException(404, "Screenshot not found.");
    var (image, type) = await mail.GetScreenshotAsync(runId, screenshotId, ct);
    return Results.File(image, type);
});

app.MapFallback(() => Results.NotFound(new { error = "Not found." }));

var url = Environment.GetEnvironmentVariable("PREVIEWLAB_URL") ??
          "http://127.0.0.1:3000";
app.Run(url);
