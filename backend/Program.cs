using System.Text.Json;
using Microsoft.AspNetCore.Http.Features;
using PdfSorter.Api;

const long MaxUpload = 1L << 30; // 1 GB - long colour scans get big

var builder = WebApplication.CreateSlimBuilder(args);
builder.WebHost.ConfigureKestrel(k => k.Limits.MaxRequestBodySize = MaxUpload);
builder.Services.Configure<FormOptions>(f => f.MultipartBodyLengthLimit = MaxUpload);
builder.Services.AddProblemDetails();

var app = builder.Build();
// Unexpected errors still come back as problem+json, which the frontend reads the "detail" from
app.UseExceptionHandler();
var jsonOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web);

app.MapGet("/api/health", () => Results.Json(new { ok = true, jbig2 = ToolRunner.IsInstalled("jbig2") }));

app.MapPost("/api/optimize", async (HttpContext ctx, IFormFile file, [Microsoft.AspNetCore.Mvc.FromForm] string? options,
    ILogger<Program> log) =>
{
    OptimizeOptions opts;
    try
    {
        opts = JsonSerializer.Deserialize<OptimizeOptions>(options ?? "{}", jsonOptions) ?? new OptimizeOptions();
    }
    catch (JsonException)
    {
        return Results.Problem(detail: "Niepoprawne opcje", statusCode: StatusCodes.Status400BadRequest);
    }

    var work = Directory.CreateTempSubdirectory("pdf-").FullName;
    // The response streams from the work dir, so clean it up only after the body has been sent
    ctx.Response.OnCompleted(() =>
    {
        try { Directory.Delete(work, recursive: true); }
        catch (IOException ex) { log.LogWarning(ex, "Could not delete {Dir}", work); }
        return Task.CompletedTask;
    });

    var src = Path.Combine(work, "in.pdf");
    await using (var fs = File.Create(src))
        await file.CopyToAsync(fs, ctx.RequestAborted);

    var started = DateTime.UtcNow;
    try
    {
        var result = await PdfOptimizer.RunAsync(src, work, opts, ctx.RequestAborted);
        log.LogInformation("Optimised {Name}: {Before} -> {After} bytes in {Seconds:F1}s",
            file.FileName, file.Length, new FileInfo(result.Path).Length, (DateTime.UtcNow - started).TotalSeconds);
        if (result.Notes.Count > 0)
            ctx.Response.Headers["X-Note"] = Uri.EscapeDataString(string.Join(" ", result.Notes));
        return Results.File(File.OpenRead(result.Path), "application/pdf");
    }
    catch (ToolFailedException ex)
    {
        log.LogWarning("Optimisation of {Name} failed: {Error}", file.FileName, ex.Message);
        return Results.Problem(detail: ex.Message, statusCode: StatusCodes.Status500InternalServerError);
    }
})
// Same-origin local tool behind nginx, no cookies/auth - antiforgery would only block the upload
.DisableAntiforgery();

app.Run();
