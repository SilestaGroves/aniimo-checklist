using System.Diagnostics;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace AniimoChecklist;

internal sealed class MainForm : Form
{
    const int HotkeyId = 0xA11;
    const int BaseWidth = 440, BaseHeight = 760;
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string RunValue = "AniimoChecklist";
    static readonly Color Background = Color.FromArgb(221, 239, 255);

    static readonly (string Spec, string Label)[] HotkeyChoices =
    {
        ("Oemtilde", "~"),
        ("Control+Oemtilde", "Ctrl + ~"),
        ("Alt+Oemtilde", "Alt + ~"),
        ("F8", "F8"),
        ("F9", "F9"),
        ("F10", "F10"),
    };

    readonly Settings settings = Settings.Load();
    readonly WebView2 web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Background };
    readonly NotifyIcon tray;
    readonly ToolStripMenuItem openItem, autostartItem;
    readonly System.Windows.Forms.Timer reminderTimer = new() { Interval = 5000 };
    List<Reminder> reminders = new();
    readonly HashSet<string> firedReminders = new();
    readonly System.Windows.Forms.Timer updateTimer = new() { Interval = 3 * 60 * 60 * 1000 };
    Updater.Release? availableUpdate;
    string updateState = "idle";
    string? updateError;
    DateTime? lastUpdateCheck;
    bool allowVisible;
    bool hotkeyOk;
    bool quitting;

    public MainForm(bool startHidden, bool justUpdated)
    {
        allowVisible = !startHidden;

        Text = "Aniimo Checklist";
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = Background;
        Icon = LoadIcon();
        Opacity = Math.Clamp(settings.Opacity, 0.5, 1.0);
        Controls.Add(web);

        openItem = new ToolStripMenuItem("", null, (_, _) => ShowPanel()) { Font = new Font(SystemFonts.MenuFont!, FontStyle.Bold) };
        autostartItem = new ToolStripMenuItem("Запускать вместе с Windows", null, (_, _) => SetAutostart(!IsAutostart()));
        var menu = new ContextMenuStrip();
        menu.Items.AddRange(new ToolStripItem[]
        {
            openItem,
            new ToolStripSeparator(),
            autostartItem,
            new ToolStripMenuItem("Открыть папку с данными", null, (_, _) => OpenDataFolder()),
            new ToolStripSeparator(),
            new ToolStripMenuItem("Выход", null, (_, _) => Quit()),
        });
        menu.Opening += (_, _) =>
        {
            openItem.Text = $"Открыть чеклист   ({HotkeyLabel(settings.Hotkey)})";
            autostartItem.Checked = IsAutostart();
        };

        tray = new NotifyIcon { Icon = new Icon(Icon, SystemInformation.SmallIconSize), Text = "Aniimo Checklist", Visible = true, ContextMenuStrip = menu };
        tray.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) Toggle(); };

        // Хэндлы нужны сразу: для горячей клавиши и чтобы WebView2 загрузился, пока окно скрыто.
        _ = Handle;
        _ = web.Handle;
        PlaceWindow();
        _ = InitWebAsync();

        reminderTimer.Tick += (_, _) => FireDueReminders();
        reminderTimer.Start();

        updateTimer.Tick += async (_, _) => await CheckUpdatesAsync();
        updateTimer.Start();
        _ = FirstUpdateCheckAsync();

        if (justUpdated)
            ToastForm.Show("Чеклист обновлён", $"Установлена версия {Updater.CurrentText}.", Color.FromArgb(30, 139, 240), ShowPanel);
        else if (startHidden && hotkeyOk)
            tray.ShowBalloonTip(3000, "Aniimo Checklist", $"Чеклист в трее. Нажми {HotkeyLabel(settings.Hotkey)}, чтобы открыть.", ToolTipIcon.None);
    }

    // ---------- Окно ----------

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ClassStyle |= Native.CS_DROPSHADOW;
            return cp;
        }
    }

    protected override void SetVisibleCore(bool value)
    {
        if (!allowVisible)
        {
            value = false;
            if (!IsHandleCreated) CreateHandle();
        }
        base.SetVisibleCore(value);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        var pref = Native.DWMWCP_ROUND;
        Native.DwmSetWindowAttribute(Handle, Native.DWMWA_WINDOW_CORNER_PREFERENCE, ref pref, sizeof(int));
        ApplyHotkey(settings.Hotkey);
    }

    protected override void OnHandleDestroyed(EventArgs e)
    {
        Native.UnregisterHotKey(Handle, HotkeyId);
        base.OnHandleDestroyed(e);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == Native.WM_HOTKEY && m.WParam == HotkeyId)
        {
            Toggle();
            return;
        }
        base.WndProc(ref m);
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!quitting && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            HidePanel();
            return;
        }
        base.OnFormClosing(e);
    }

    void PlaceWindow()
    {
        var scale = DeviceDpi / 96f;
        var screen = settings.X is int sx && settings.Y is int sy
            ? Screen.FromPoint(new Point(sx, sy))
            : Screen.FromPoint(Cursor.Position);
        var wa = screen.WorkingArea;
        var w = (int)(BaseWidth * scale);
        var h = Math.Min((int)(BaseHeight * scale), wa.Height - (int)(32 * scale));
        Size = new Size(w, h);

        var pos = settings.X is int x && settings.Y is int y
            ? new Point(x, y)
            : new Point(wa.Right - w - (int)(24 * scale), wa.Top + (wa.Height - h) / 2);

        // Если сохранённая позиция оказалась за пределами экранов (сменили монитор) — вернуть на экран.
        var visible = Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(new Rectangle(pos.X + 40, pos.Y, w - 80, 40)));
        if (!visible) pos = new Point(wa.Right - w - (int)(24 * scale), wa.Top + (wa.Height - h) / 2);
        Location = pos;
    }

    public void ShowPanel()
    {
        allowVisible = true;
        if (!Visible) PlaceWindow();
        Show();
        Activate();
        Native.SetForegroundWindow(Handle);
        web.Focus();
        Post(new { type = "shown" });
    }

    void HidePanel()
    {
        if (!Visible) return;
        settings.X = Left;
        settings.Y = Top;
        settings.Save();
        Hide();
    }

    void Toggle()
    {
        if (Visible) HidePanel();
        else ShowPanel();
    }

    void Quit()
    {
        HidePanel();
        quitting = true;
        tray.Visible = false;
        Application.Exit();
    }

    // ---------- Горячая клавиша ----------

    bool ApplyHotkey(string spec)
    {
        Native.UnregisterHotKey(Handle, HotkeyId);
        var (mods, vk) = ParseHotkey(spec);
        hotkeyOk = vk != 0 && Native.RegisterHotKey(Handle, HotkeyId, mods | Native.MOD_NOREPEAT, vk);
        if (!hotkeyOk)
            tray?.ShowBalloonTip(4000, "Aniimo Checklist",
                $"Не удалось занять клавишу {HotkeyLabel(spec)} — возможно, её использует другая программа. Выбери другую в настройках.",
                ToolTipIcon.Warning);
        return hotkeyOk;
    }

    static (uint Mods, uint Vk) ParseHotkey(string spec)
    {
        uint mods = 0, vk = 0;
        foreach (var part in spec.Split('+', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            switch (part.ToLowerInvariant())
            {
                case "control" or "ctrl": mods |= Native.MOD_CONTROL; break;
                case "alt": mods |= Native.MOD_ALT; break;
                case "shift": mods |= Native.MOD_SHIFT; break;
                default:
                    if (Enum.TryParse<Keys>(part, true, out var key)) vk = (uint)key;
                    break;
            }
        }
        return (mods, vk);
    }

    static string HotkeyLabel(string spec) =>
        HotkeyChoices.FirstOrDefault(c => c.Spec == spec).Label ?? spec;

    // ---------- Автозапуск ----------

    static bool IsAutostart()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey);
        return key?.GetValue(RunValue) is string;
    }

    static void SetAutostart(bool enable)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey);
        if (enable) key.SetValue(RunValue, $"\"{Environment.ProcessPath}\" --tray");
        else key.DeleteValue(RunValue, false);
    }

    // ---------- WebView2 ----------

    async Task InitWebAsync()
    {
        try
        {
            var userData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AniimoChecklist", "WebView2");
            var env = await CoreWebView2Environment.CreateAsync(null, userData);
            await web.EnsureCoreWebView2Async(env);

            var core = web.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.SetVirtualHostNameToFolderMapping("app.local",
                Path.Combine(AppContext.BaseDirectory, "web"), CoreWebView2HostResourceAccessKind.Allow);
            core.WebMessageReceived += OnWebMessage;

            // data.json отдаём сами (скачанный с GitHub, если он новее встроенного) с отдельного адреса:
            // запросы к app.local WebView2 обслуживает из папки раньше, чем срабатывает перехват.
            core.AddWebResourceRequestedFilter("https://data.local/*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += (_, e) =>
            {
                var body = new MemoryStream(File.ReadAllBytes(Updater.ActiveDataPath));
                e.Response = core.Environment.CreateWebResourceResponse(body, 200, "OK",
                    "Content-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\n" +
                    "Access-Control-Allow-Origin: https://app.local");
            };
            core.NewWindowRequested += (_, e) =>
            {
                e.Handled = true;
                Process.Start(new ProcessStartInfo(e.Uri) { UseShellExecute = true });
            };
            core.Navigate("https://app.local/index.html");
        }
        catch (Exception ex)
        {
            MessageBox.Show("Не удалось запустить WebView2.\n\n" + ex.Message, "Aniimo Checklist",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        using var doc = JsonDocument.Parse(e.WebMessageAsJson);
        var msg = doc.RootElement;
        var type = msg.TryGetProperty("type", out var t) ? t.GetString() : null;

        switch (type)
        {
            case "hide":
                HidePanel();
                break;
            case "drag":
                Native.ReleaseCapture();
                Native.SendMessage(Handle, Native.WM_NCLBUTTONDOWN, Native.HTCAPTION, IntPtr.Zero);
                break;
            case "quit":
                Quit();
                break;
            case "open-data":
                OpenDataFolder();
                break;
            case "open-url" when msg.TryGetProperty("url", out var url) && url.GetString() is string u
                                 && u.StartsWith("https://", StringComparison.OrdinalIgnoreCase):
                Process.Start(new ProcessStartInfo(u) { UseShellExecute = true });
                break;
            case "set-hotkey" when msg.TryGetProperty("value", out var hk) && hk.GetString() is string spec:
                if (ApplyHotkey(spec)) { settings.Hotkey = spec; settings.Save(); }
                else ApplyHotkey(settings.Hotkey);
                SendSettings();
                break;
            case "set-autostart" when msg.TryGetProperty("value", out var on):
                SetAutostart(on.GetBoolean());
                SendSettings();
                break;
            case "set-opacity" when msg.TryGetProperty("value", out var op):
                Opacity = Math.Clamp(op.GetDouble(), 0.5, 1.0);
                settings.Opacity = Opacity;
                settings.Save();
                break;
            case "set-volume" when msg.TryGetProperty("value", out var vol):
                settings.Volume = Math.Clamp(vol.GetDouble(), 0, 1);
                settings.Save();
                break;
            case "preview-bell":
                PlayBell();
                break;
            case "get-settings":
                SendSettings();
                break;
            case "get-update":
                SendUpdate();
                break;
            case "check-update":
                _ = CheckUpdatesAsync();
                break;
            case "do-update":
                _ = InstallUpdateAsync();
                break;
            case "reminders" when msg.TryGetProperty("items", out var items):
                reminders = items.Deserialize<List<Reminder>>(JsonOptions) ?? new();
                FireDueReminders();
                break;
            case "test-notify":
                ToastForm.Show("Так выглядит напоминание", "Кликни, чтобы открыть чеклист. Само закроется через 12 секунд.",
                    Color.FromArgb(30, 139, 240), ShowPanel);
                PlayBell();
                break;
        }
    }

    // ---------- Напоминания ----------
    // Страница присылает список напоминаний с точным временем, а срабатывают они здесь:
    // таймеры скрытого WebView2 браузер притормаживает.

    sealed record Reminder(string Id, long At, long Until, long End, string Title, string Text, string Color);

    static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    void FireDueReminders()
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var due = reminders.Where(r => r.At <= now && now < r.Until && firedReminders.Add(r.Id)).ToList();
        foreach (var r in due)
        {
            var text = r.Text.Replace("{left}", FormatLeft(r.End - now));
            ToastForm.Show(r.Title, text, ParseColor(r.Color), ShowPanel);
            Post(new { type = "fired", id = r.Id });
        }
        if (due.Count > 0) PlayBell();
    }

    static string FormatLeft(long ms)
    {
        var t = TimeSpan.FromMilliseconds(Math.Max(0, ms) + 30_000);
        if (t.TotalDays >= 1) return $"{(int)t.TotalDays} д {t.Hours} ч";
        if (t.TotalHours >= 1) return t.Minutes > 0 ? $"{(int)t.TotalHours} ч {t.Minutes} мин" : $"{(int)t.TotalHours} ч";
        return $"{Math.Max(1, t.Minutes)} мин";
    }

    void PlayBell() => Bell.Play(settings.Volume);

    static Color ParseColor(string hex)
    {
        try { return ColorTranslator.FromHtml(hex); }
        catch { return Color.FromArgb(30, 139, 240); }
    }

    // ---------- Обновления ----------

    async Task FirstUpdateCheckAsync()
    {
        await Task.Delay(TimeSpan.FromSeconds(10));
        await CheckUpdatesAsync();
    }

    async Task CheckUpdatesAsync()
    {
        if (updateState is "checking" or "downloading") return;
        updateState = "checking";
        SendUpdate();
        try
        {
            if (await Updater.RefreshDataAsync()) Post(new { type = "data-updated" });

            var latest = await Updater.GetLatestReleaseAsync();
            availableUpdate = latest is { IsNewer: true } ? latest : null;
            updateState = availableUpdate is null ? "latest" : "available";
            updateError = null;

            if (availableUpdate is not null && settings.NotifiedVersion != availableUpdate.VersionText)
            {
                settings.NotifiedVersion = availableUpdate.VersionText;
                settings.Save();
                ToastForm.Show($"Доступна версия {availableUpdate.VersionText}",
                    "Открой чеклист и нажми «Обновить» — это займёт пару секунд.", Color.FromArgb(30, 139, 240), ShowPanel);
            }
        }
        catch (Exception ex)
        {
            updateState = "error";
            updateError = ex is HttpRequestException or TaskCanceledException
                ? "Нет связи с GitHub — попробую позже."
                : "Не удалось проверить: " + ex.Message;
        }
        lastUpdateCheck = DateTime.Now;
        SendUpdate();
    }

    async Task InstallUpdateAsync()
    {
        if (availableUpdate is null || updateState == "downloading") return;
        if (!Updater.CanWriteAppFolder())
        {
            updateState = "error";
            updateError = "Папка программы защищена от записи. Перенеси чеклист, например, в Документы.";
            SendUpdate();
            return;
        }

        updateState = "downloading";
        SendUpdate();
        try
        {
            var files = await Updater.DownloadAsync(availableUpdate);
            Updater.LaunchInstaller(files);
            Quit();
        }
        catch (Exception ex)
        {
            updateState = "error";
            updateError = "Не удалось обновить: " + ex.Message;
            SendUpdate();
        }
    }

    void SendUpdate() => Post(new
    {
        type = "update",
        state = updateState,
        current = Updater.CurrentText,
        latest = availableUpdate?.VersionText,
        notes = availableUpdate?.Notes,
        checkedAt = lastUpdateCheck?.ToString("HH:mm"),
        error = updateError,
        dataRevision = Updater.ActiveRevision,
    });

    void SendSettings() => Post(new
    {
        type = "settings",
        hotkey = settings.Hotkey,
        hotkeyOk,
        hotkeys = HotkeyChoices.Select(c => new { spec = c.Spec, label = c.Label }),
        autostart = IsAutostart(),
        opacity = settings.Opacity,
        volume = settings.Volume,
    });

    void Post(object message)
    {
        if (web.CoreWebView2 is { } core)
            core.PostWebMessageAsJson(JsonSerializer.Serialize(message));
    }

    static void OpenDataFolder() =>
        Process.Start(new ProcessStartInfo(Path.Combine(AppContext.BaseDirectory, "web")) { UseShellExecute = true });

    static Icon LoadIcon()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "assets", "app.ico");
        return File.Exists(path) ? new Icon(path) : SystemIcons.Application;
    }
}
