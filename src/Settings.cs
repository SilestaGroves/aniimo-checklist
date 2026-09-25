using System.Text.Json;

namespace AniimoChecklist;

internal sealed class Settings
{
    public string Hotkey { get; set; } = "Oemtilde";
    public double Opacity { get; set; } = 1.0;
    public double Volume { get; set; } = 0.8;
    public string? NotifiedVersion { get; set; }
    public int? X { get; set; }
    public int? Y { get; set; }

    static readonly string Dir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "AniimoChecklist");
    static readonly string FilePath = Path.Combine(Dir, "settings.json");

    public static Settings Load()
    {
        try
        {
            if (File.Exists(FilePath))
                return JsonSerializer.Deserialize<Settings>(File.ReadAllText(FilePath)) ?? new();
        }
        catch { }
        return new();
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Dir);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch { }
    }
}
