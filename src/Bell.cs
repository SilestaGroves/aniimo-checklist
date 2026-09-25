using System.Media;
using System.Text;

namespace AniimoChecklist;

/// <summary>
/// Колокольчик напоминаний с регулировкой громкости.
/// SoundPlayer громкость не умеет, поэтому сэмплы WAV масштабируются перед воспроизведением.
/// </summary>
internal static class Bell
{
    static readonly byte[]? Wav = Load();
    static SoundPlayer? player;
    static double playerVolume = -1;

    public static void Play(double volume)
    {
        volume = Math.Clamp(volume, 0, 1);
        if (volume <= 0) return;
        if (Wav is null)
        {
            SystemSounds.Asterisk.Play();
            return;
        }
        if (player is null || playerVolume != volume)
        {
            player?.Dispose();
            player = new SoundPlayer(new MemoryStream(Scale(Wav, volume)));
            player.Load();
            playerVolume = volume;
        }
        player.Play();
    }

    static byte[]? Load()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "assets", "bell.wav");
        return File.Exists(path) ? File.ReadAllBytes(path) : null;
    }

    /// <summary>Копия WAV с громкостью volume. Работает с 16-битным PCM, остальное отдаёт как есть.</summary>
    static byte[] Scale(byte[] wav, double volume)
    {
        var copy = (byte[])wav.Clone();
        int bits = 0, dataStart = -1, dataSize = 0;

        for (var pos = 12; pos + 8 <= copy.Length;)
        {
            var id = Encoding.ASCII.GetString(copy, pos, 4);
            var size = BitConverter.ToInt32(copy, pos + 4);
            if (id == "fmt ") bits = BitConverter.ToInt16(copy, pos + 22);
            if (id == "data") { dataStart = pos + 8; dataSize = Math.Min(size, copy.Length - dataStart); break; }
            pos += 8 + size + (size & 1);
        }
        if (bits != 16 || dataStart < 0) return copy;

        // Квадрат даёт более естественную шкалу: на слух громкость растёт равномернее.
        var gain = volume * volume;
        for (var i = dataStart; i + 1 < dataStart + dataSize; i += 2)
        {
            var sample = BitConverter.ToInt16(copy, i);
            var scaled = (short)Math.Round(sample * gain);
            copy[i] = (byte)scaled;
            copy[i + 1] = (byte)(scaled >> 8);
        }
        return copy;
    }
}
