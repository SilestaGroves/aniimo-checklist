namespace AniimoChecklist;

internal static class Program
{
    const string MutexName = @"Local\AniimoChecklist.Instance";
    const string ShowEventName = @"Local\AniimoChecklist.Show";

    [STAThread]
    static void Main(string[] args)
    {
        using var mutex = new Mutex(true, MutexName, out var isFirstInstance);
        if (!isFirstInstance)
        {
            // Уже запущено — просим первую копию показать окно.
            try { EventWaitHandle.OpenExisting(ShowEventName).Set(); } catch { }
            return;
        }

        ApplicationConfiguration.Initialize();

        using var showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName);
        var justUpdated = args.Contains("--updated", StringComparer.OrdinalIgnoreCase);
        var startHidden = justUpdated || args.Contains("--tray", StringComparer.OrdinalIgnoreCase);
        using var form = new MainForm(startHidden, justUpdated);

        ThreadPool.RegisterWaitForSingleObject(showEvent,
            (_, _) => form.BeginInvoke(form.ShowPanel), null, Timeout.Infinite, false);

        Application.Run(form);
    }
}
