namespace AniimoChecklist;

/// <summary>Всплывашка-напоминание в правом нижнем углу. Не забирает фокус у игры.</summary>
internal sealed class ToastForm : Form
{
    const int WS_EX_TOPMOST = 0x8, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000;
    const int BaseWidth = 380, BaseHeight = 96, Gap = 10, Margin = 16;
    static readonly List<ToastForm> Open = new();
    static readonly Image? Buddy = LoadBuddy();
    static readonly Color Ink = Color.FromArgb(27, 42, 74);
    static readonly Color Muted = Color.FromArgb(95, 111, 140);
    static readonly Color Brand = Color.FromArgb(5, 137, 223);

    readonly string title, text;
    readonly Color accent;
    readonly System.Windows.Forms.Timer life = new() { Interval = 12000 };
    readonly Font titleFont = new("Segoe UI", 10.5f, FontStyle.Bold);
    readonly Font textFont = new("Segoe UI", 9.5f);
    readonly Font brandFont = new("Segoe UI", 7.5f, FontStyle.Bold | FontStyle.Italic);

    public ToastForm(string title, string text, Color accent, Action onClick)
    {
        this.title = title;
        this.text = text;
        this.accent = accent;

        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.FromArgb(247, 251, 255);
        DoubleBuffered = true;
        Cursor = Cursors.Hand;
        var scale = DeviceDpi / 96f;
        Size = new Size((int)(BaseWidth * scale), (int)(BaseHeight * scale));

        MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left) onClick();
            Close();
        };
        MouseEnter += (_, _) => life.Stop();
        MouseLeave += (_, _) => life.Start();
        life.Tick += (_, _) => Close();
    }

    public static void Show(string title, string text, Color accent, Action onClick)
    {
        var toast = new ToastForm(title, text, accent, onClick);
        Open.Add(toast);
        Relayout();
        toast.Show();
        toast.life.Start();
    }

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
            cp.ClassStyle |= Native.CS_DROPSHADOW;
            return cp;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        var pref = Native.DWMWCP_ROUND;
        Native.DwmSetWindowAttribute(Handle, Native.DWMWA_WINDOW_CORNER_PREFERENCE, ref pref, sizeof(int));
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        var s = DeviceDpi / 96f;
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;

        // Небесный фон как у панелей игры: белый сверху, голубой снизу.
        using (var sky = new System.Drawing.Drawing2D.LinearGradientBrush(ClientRectangle,
                   Color.FromArgb(255, 255, 255), Color.FromArgb(222, 240, 255), 90f))
            g.FillRectangle(sky, ClientRectangle);
        using (var border = new Pen(Color.FromArgb(190, 222, 250)))
            g.DrawRectangle(border, 0, 0, Width - 1, Height - 1);
        using (var bar = new SolidBrush(accent))
            g.FillRectangle(bar, 0, 0, (int)(4 * s), Height);

        var icon = (int)(46 * s);
        var iconLeft = (int)(16 * s);
        if (Buddy is not null)
        {
            using (var halo = new SolidBrush(Color.FromArgb(40, accent)))
                g.FillEllipse(halo, iconLeft - (int)(4 * s), (Height - icon) / 2 - (int)(4 * s), icon + (int)(8 * s), icon + (int)(8 * s));
            g.DrawImage(Buddy, iconLeft, (Height - icon) / 2, icon, icon);
        }

        var left = iconLeft + icon + (int)(14 * s);
        var width = Width - left - (int)(14 * s);
        var flags = TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix;

        TextRenderer.DrawText(g, "✦ ANIIMO · НАПОМИНАНИЕ", brandFont,
            new Rectangle(left, (int)(11 * s), width, (int)(16 * s)), Brand, flags);
        TextRenderer.DrawText(g, title, titleFont,
            new Rectangle(left, (int)(27 * s), width, (int)(22 * s)), Ink, flags);
        TextRenderer.DrawText(g, text, textFont,
            new Rectangle(left, (int)(50 * s), width, Height - (int)(54 * s)), Muted,
            flags | TextFormatFlags.WordBreak);
    }

    static Image? LoadBuddy()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "assets", "buddy.png");
        return File.Exists(path) ? Image.FromFile(path) : null;
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        life.Dispose();
        Open.Remove(this);
        Relayout();
        base.OnFormClosed(e);
    }

    static void Relayout()
    {
        if (Screen.PrimaryScreen is not { } screen) return;
        var wa = screen.WorkingArea;
        var y = wa.Bottom;
        foreach (var t in Open)
        {
            var s = t.DeviceDpi / 96f;
            y -= t.Height + (int)(Gap * s);
            t.Location = new Point(wa.Right - t.Width - (int)(Margin * s), y - (int)((Margin - Gap) * s));
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            titleFont.Dispose();
            textFont.Dispose();
            brandFont.Dispose();
        }
        base.Dispose(disposing);
    }
}
