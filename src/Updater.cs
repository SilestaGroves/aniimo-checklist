using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http.Headers;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace AniimoChecklist;

/// <summary>
/// Обновления через GitHub: данные ивентов берутся из ветки main,
/// новые версии приложения — из последнего релиза.
/// </summary>
internal static class Updater
{
    public const string Repo = "SilestaGroves/aniimo-checklist";
    const string Branch = "main";

    // Порядок важен: статические поля инициализируются сверху вниз, а клиенту нужна версия.
    public static Version Current { get; } = Normalize(Assembly.GetEntryAssembly()?.GetName().Version);
    public static string CurrentText => Format(Current);

    static readonly HttpClient Http = CreateClient();
    static readonly string AppDataDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AniimoChecklist");

    public sealed record Release(Version Version, string Notes, string Url, string? Sha256)
    {
        public string VersionText => Format(Version);
        public bool IsNewer => Version > Current;
    }

    // ---------- Данные ивентов ----------

    static string CachedDataPath => Path.Combine(AppDataDir, "data.json");
    static string BundledDataPath => Path.Combine(AppContext.BaseDirectory, "web", "data.json");

    /// <summary>Файл данных, который отдаётся странице: скачанный, если он новее встроенного.</summary>
    public static string ActiveDataPath => Revision(CachedDataPath) > Revision(BundledDataPath) ? CachedDataPath : BundledDataPath;

    public static int ActiveRevision => Revision(ActiveDataPath);

    /// <summary>Скачивает data.json из репозитория. true — если пришла более новая ревизия.</summary>
    public static async Task<bool> RefreshDataAsync()
    {
        var url = $"https://raw.githubusercontent.com/{Repo}/{Branch}/web/data.json?t={DateTimeOffset.UtcNow.ToUnixTimeSeconds()}";
        using var resp = await Http.GetAsync(url);
        if (!resp.IsSuccessStatusCode) return false;
        var json = await resp.Content.ReadAsStringAsync();

        int revision;
        using (var doc = JsonDocument.Parse(json))
        {
            if (!doc.RootElement.TryGetProperty("events", out _)) return false;
            revision = RevisionOf(doc.RootElement);
        }
        if (revision <= ActiveRevision) return false;

        Directory.CreateDirectory(AppDataDir);
        var tmp = CachedDataPath + ".tmp";
        await File.WriteAllTextAsync(tmp, json, new UTF8Encoding(false));
        File.Move(tmp, CachedDataPath, true);
        return true;
    }

    static int Revision(string path)
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            return RevisionOf(doc.RootElement);
        }
        catch { return -1; }
    }

    static int RevisionOf(JsonElement root) =>
        root.TryGetProperty("revision", out var r) && r.TryGetInt32(out var n) ? n : 0;

    // ---------- Новые версии приложения ----------

    /// <summary>Последний релиз на GitHub или null, если релизов ещё нет.</summary>
    public static async Task<Release?> GetLatestReleaseAsync()
    {
        using var resp = await Http.GetAsync($"https://api.github.com/repos/{Repo}/releases/latest");
        if (resp.StatusCode == System.Net.HttpStatusCode.NotFound) return null;
        resp.EnsureSuccessStatusCode();

        using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
        var root = doc.RootElement;
        var tag = root.GetProperty("tag_name").GetString()?.TrimStart('v', 'V');
        if (!Version.TryParse(tag, out var version)) return null;

        foreach (var asset in root.GetProperty("assets").EnumerateArray())
        {
            var name = asset.GetProperty("name").GetString() ?? "";
            if (!name.EndsWith(".zip", StringComparison.OrdinalIgnoreCase)) continue;
            string? sha = null;
            if (asset.TryGetProperty("digest", out var d) && d.GetString() is string digest && digest.StartsWith("sha256:"))
                sha = digest["sha256:".Length..];
            var notes = root.TryGetProperty("body", out var b) ? b.GetString() ?? "" : "";
            return new Release(Normalize(version), notes.Trim(), asset.GetProperty("browser_download_url").GetString()!, sha);
        }
        return null;
    }

    /// <summary>Можно ли писать в папку приложения (иначе обновить файлы не выйдет).</summary>
    public static bool CanWriteAppFolder()
    {
        try
        {
            var probe = Path.Combine(AppContext.BaseDirectory, ".write-test");
            File.WriteAllText(probe, "");
            File.Delete(probe);
            return true;
        }
        catch { return false; }
    }

    /// <summary>Скачивает и распаковывает релиз, проверив контрольную сумму. Возвращает папку с файлами.</summary>
    public static async Task<string> DownloadAsync(Release release)
    {
        var dir = Path.Combine(Path.GetTempPath(), "AniimoChecklist-update", release.VersionText);
        if (Directory.Exists(dir)) Directory.Delete(dir, true);
        Directory.CreateDirectory(dir);

        var zip = Path.Combine(dir, "update.zip");
        using (var resp = await Http.GetAsync(release.Url, HttpCompletionOption.ResponseHeadersRead))
        {
            resp.EnsureSuccessStatusCode();
            await using var file = File.Create(zip);
            await resp.Content.CopyToAsync(file);
        }

        if (release.Sha256 is { } expected)
        {
            await using var file = File.OpenRead(zip);
            var actual = Convert.ToHexString(await SHA256.HashDataAsync(file));
            if (!actual.Equals(expected, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("контрольная сумма архива не совпала");
        }

        var files = Path.Combine(dir, "files");
        ZipFile.ExtractToDirectory(zip, files);
        if (!File.Exists(Path.Combine(files, "AniimoChecklist.exe")))
            throw new InvalidDataException("в архиве нет AniimoChecklist.exe");
        return files;
    }

    /// <summary>Запускает скрипт, который дождётся выхода программы, заменит файлы и запустит новую версию.</summary>
    public static void LaunchInstaller(string files)
    {
        var script = Path.Combine(Path.GetDirectoryName(files)!, "install.ps1");
        File.WriteAllText(script, InstallScript, new UTF8Encoding(true));

        var psi = new ProcessStartInfo("powershell.exe") { UseShellExecute = false, CreateNoWindow = true };
        foreach (var arg in new[]
                 {
                     "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script,
                     "-ProcessId", Environment.ProcessId.ToString(),
                     "-Source", files,
                     "-Target", AppContext.BaseDirectory.TrimEnd('\\'),
                 })
            psi.ArgumentList.Add(arg);
        Process.Start(psi);
    }

    const string InstallScript = """
        param([int]$ProcessId, [string]$Source, [string]$Target)
        $log = Join-Path $env:LOCALAPPDATA 'AniimoChecklist\update.log'
        function Log($m) { Add-Content -Path $log -Value "$(Get-Date -Format s) $m" -Encoding UTF8 }
        Log "Installing from $Source to $Target"
        try { Wait-Process -Id $ProcessId -Timeout 30 -ErrorAction Stop } catch { }
        Start-Sleep -Milliseconds 500
        for ($i = 1; $i -le 10; $i++) {
            try {
                Copy-Item -Path (Join-Path $Source '*') -Destination $Target -Recurse -Force -ErrorAction Stop
                Log 'Files copied'
                break
            } catch {
                Log "Attempt ${i}: $($_.Exception.Message)"
                Start-Sleep -Seconds 1
            }
        }
        Start-Process -FilePath (Join-Path $Target 'AniimoChecklist.exe') -ArgumentList '--updated'
        """;

    // ---------- Общее ----------

    static HttpClient CreateClient()
    {
        var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("AniimoChecklist", Format(Current)));
        return http;
    }

    static Version Normalize(Version? v) =>
        v is null ? new Version(0, 0, 0) : new Version(v.Major, Math.Max(v.Minor, 0), Math.Max(v.Build, 0));

    static string Format(Version v) => $"{v.Major}.{v.Minor}.{v.Build}";
}
