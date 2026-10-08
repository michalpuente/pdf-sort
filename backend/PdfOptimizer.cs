namespace PdfSorter.Api;

public record OptimizeOptions(
    int Dpi = 0,
    bool Gray = false,
    string? Quality = "high",
    bool Ocr = false,
    bool Deskew = false,
    bool Rotate = false,
    bool Pdfa = false,
    bool Strip = false,
    string? Password = null);

public record OptimizeResult(string Path, IReadOnlyList<string> Notes);

/// <summary>
/// Pipeline: Ghostscript (optional downsampling / grayscale) -> OCRmyPDF (OCR, deskew, lossless image
/// optimisation incl. JBIG2) -> qpdf (metadata stripping, encryption, final object-stream packing).
/// </summary>
public static class PdfOptimizer
{
    // Ghostscript JPEG QFactor: lower is better quality (0.15 is roughly JPEG q90, 0.4 roughly q75)
    private static readonly Dictionary<string, string> QFactors = new() { ["high"] = "0.15", ["medium"] = "0.4" };
    private static readonly string Jobs = Environment.ProcessorCount.ToString();
    // OCRmyPDF exit code 10: output was written but is not valid PDF/A - still a usable PDF
    private const int OcrmypdfPdfaInvalid = 10;
    // qpdf exit code 3: succeeded with warnings (common on slightly malformed scanner output)
    private const int QpdfWarnings = 3;

    public static async Task<OptimizeResult> RunAsync(string src, string work, OptimizeOptions o, CancellationToken ct)
    {
        if (o.Pdfa)
        {
            // PDF/A requires XMP metadata and forbids encryption
            o = o with { Strip = false, Password = null };
        }

        var notes = new List<string>();
        var current = src;

        if (o.Dpi > 0 || o.Gray)
        {
            var gs = Path.Combine(work, "gs.pdf");
            await GhostscriptAsync(current, gs, o, ct);
            current = gs;
        }

        var ocr = Path.Combine(work, "ocr.pdf");
        if (await OcrmypdfAsync(current, ocr, o, ct))
            notes.Add("Nie udało się uzyskać pełnej zgodności z PDF/A - zapisano jako zwykły PDF.");
        current = ocr;

        // Pure size optimisation must never make the file bigger; OCR/PDF/A/deskew add content on purpose
        var contentChanging = o.Ocr || o.Pdfa || o.Deskew || o.Rotate;
        if (!contentChanging && new FileInfo(current).Length >= new FileInfo(src).Length)
        {
            current = src;
            notes.Add("Tego pliku nie dało się już zmniejszyć - zwrócono oryginał.");
        }

        var output = Path.Combine(work, "out.pdf");
        await FinalizeAsync(current, output, work, o, ct);
        return new OptimizeResult(output, notes);
    }

    private static Task GhostscriptAsync(string src, string dst, OptimizeOptions o, CancellationToken ct)
    {
        var q = QFactors.GetValueOrDefault(o.Quality ?? "high", QFactors["high"]);
        // 1x1 chroma sampling: the default 2x2 subsampling smears coloured stamps and signatures
        var imgDict = $"<< /QFactor {q} /Blend 1 /HSamples [1 1 1 1] /VSamples [1 1 1 1] >>";
        var distillerParams =
            "<< /AutoFilterColorImages false /AutoFilterGrayImages false " +
            "/ColorImageFilter /DCTEncode /GrayImageFilter /DCTEncode " +
            $"/ColorImageDict {imgDict} /GrayImageDict {imgDict} >> setdistillerparams";

        var args = new List<string>
        {
            "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=pdfwrite",
            "-dCompatibilityLevel=1.7", "-dDetectDuplicateImages=true",
            // 1-bit scans are already tiny once JBIG2-encoded; downsampling them only hurts legibility
            "-dDownsampleMonoImages=false",
        };
        if (o.Dpi > 0)
        {
            args.AddRange([
                "-dDownsampleColorImages=true", "-dDownsampleGrayImages=true",
                "-dColorImageDownsampleType=/Bicubic", "-dGrayImageDownsampleType=/Bicubic",
                $"-dColorImageResolution={o.Dpi}", $"-dGrayImageResolution={o.Dpi}",
                // leave images that are only slightly above target alone - re-encoding them gains nothing
                "-dColorImageDownsampleThreshold=1.2", "-dGrayImageDownsampleThreshold=1.2",
            ]);
        }
        else
        {
            args.AddRange(["-dDownsampleColorImages=false", "-dDownsampleGrayImages=false"]);
        }
        if (o.Gray) args.AddRange(["-sColorConversionStrategy=Gray", "-dProcessColorModel=/DeviceGray"]);
        args.AddRange([$"-sOutputFile={dst}", "-c", distillerParams, "-f", src]);

        return ToolRunner.RunAsync("gs", args, "Ghostscript", ct);
    }

    /// <returns>true when PDF/A was requested but the output is not fully conformant</returns>
    private static async Task<bool> OcrmypdfAsync(string src, string dst, OptimizeOptions o, CancellationToken ct)
    {
        var args = new List<string>
        {
            "-l", "pol+eng", "--jobs", Jobs,
            // level 1 = lossless only (JBIG2 lossless, better Flate); lossy work is Ghostscript's job
            "--optimize", "1",
            "--output-type", o.Pdfa ? "pdfa" : "pdf",
            "--skip-text",
        };
        // documented way to run OCRmyPDF purely as an optimiser
        if (!o.Ocr) args.AddRange(["--tesseract-timeout", "0"]);
        if (o.Deskew) args.Add("--deskew");
        if (o.Rotate) args.Add("--rotate-pages");
        args.AddRange([src, dst]);

        var code = await ToolRunner.RunAsync("ocrmypdf", args, "OCRmyPDF", ct, 0, OcrmypdfPdfaInvalid);
        return code == OcrmypdfPdfaInvalid;
    }

    private static async Task FinalizeAsync(string src, string dst, string work, OptimizeOptions o, CancellationToken ct)
    {
        var args = new List<string> { src, "--object-streams=generate", "--compress-streams=y" };
        if (o.Strip) args.AddRange(["--remove-info", "--remove-metadata"]);
        if (!string.IsNullOrEmpty(o.Password)) args.AddRange(["--encrypt", o.Password, o.Password, "256", "--"]);
        args.Add(dst);

        // Arguments go through an @file so the password never shows up in the process list
        var argFile = Path.Combine(work, "qpdf.args");
        await File.WriteAllLinesAsync(argFile, args, ct);
        await ToolRunner.RunAsync("qpdf", [$"@{argFile}"], "qpdf", ct, 0, QpdfWarnings);
    }
}
