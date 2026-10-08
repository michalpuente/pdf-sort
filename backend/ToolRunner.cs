using System.Diagnostics;

namespace PdfSorter.Api;

public class ToolFailedException(string message) : Exception(message);

public static class ToolRunner
{
    /// <summary>Runs a CLI tool; kills it when the HTTP request is aborted so cancelled OCR jobs don't keep burning CPU.</summary>
    public static async Task<int> RunAsync(string tool, IEnumerable<string> args, string displayName,
        CancellationToken ct, params int[] okCodes)
    {
        var psi = new ProcessStartInfo(tool)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);

        using var proc = Process.Start(psi) ?? throw new ToolFailedException($"Nie udało się uruchomić {displayName}");
        // Both streams must be drained concurrently, otherwise a chatty tool blocks on a full pipe buffer
        var stdout = proc.StandardOutput.ReadToEndAsync(CancellationToken.None);
        var stderr = proc.StandardError.ReadToEndAsync(CancellationToken.None);
        try
        {
            await proc.WaitForExitAsync(ct);
        }
        catch (OperationCanceledException)
        {
            proc.Kill(entireProcessTree: true);
            throw;
        }

        if (okCodes.Length == 0) okCodes = [0];
        if (!okCodes.Contains(proc.ExitCode))
        {
            var output = (await stderr).Trim();
            if (output.Length == 0) output = (await stdout).Trim();
            var tail = output.Split('\n').TakeLast(5).Select(l => l.Trim());
            throw new ToolFailedException($"{displayName} zakończył się błędem: {string.Join(" | ", tail)}");
        }
        return proc.ExitCode;
    }

    public static bool IsInstalled(string tool) =>
        (Environment.GetEnvironmentVariable("PATH") ?? "")
            .Split(Path.PathSeparator)
            .Any(dir => File.Exists(Path.Combine(dir, tool)));
}
