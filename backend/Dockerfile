FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG TARGETARCH
WORKDIR /src
COPY PdfSorter.Api.csproj .
# Map Docker arch (amd64/arm64) to .NET RID so the image runs natively on Apple Silicon too
RUN echo "linux-$( [ "$TARGETARCH" = arm64 ] && echo arm64 || echo x64 )" > /rid \
    && dotnet restore -r $(cat /rid)
COPY *.cs ./
# Self-contained so the runtime image can stay on Debian trixie, which has the newest OCR toolchain
RUN dotnet publish -c Release -r $(cat /rid) --self-contained --no-restore -o /out

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ocrmypdf tesseract-ocr-pol tesseract-ocr-eng tesseract-ocr-osd ghostscript pngquant jbig2 qpdf \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out .
ENV ASPNETCORE_URLS=http://0.0.0.0:8000 \
    Logging__LogLevel__Microsoft.AspNetCore=Warning
EXPOSE 8000
ENTRYPOINT ["./PdfSorter.Api"]
