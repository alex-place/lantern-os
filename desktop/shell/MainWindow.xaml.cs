using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;

namespace Unisona.Shell;

public partial class MainWindow : Window
{
    private readonly CoreProcess _core = new();
    private bool _revealed;

    public MainWindow()
    {
        InitializeComponent();
        _core.Status += s => Dispatcher.Invoke(() => Status.Text = s);
        SourceInitialized += OnSourceInitialized;
        Loaded += OnLoaded;
        Closing += OnClosing;
        RestoreWindowBounds();
    }

    // ── Native window polish ─────────────────────────────────────────────────────
    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        // Dark title bar to match the app — a browser would never do this.
        var hwnd = new WindowInteropHelper(this).Handle;
        int on = 1;
        // DWMWA_USE_IMMERSIVE_DARK_MODE = 20 (Win10 2004+ / Win11).
        DwmSetWindowAttribute(hwnd, 20, ref on, sizeof(int));
    }

    // ── Boot ─────────────────────────────────────────────────────────────────────
    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        try
        {
            var url = await _core.StartAsync(TimeSpan.FromSeconds(60), CancellationToken.None);
            await InitWebViewAsync(url);
        }
        catch (Exception ex)
        {
            Log.Write($"boot failed: {ex}");
            Bar.Visibility = Visibility.Collapsed;
            Status.Text = "Couldn't start Unisona.";
            RetryHint.Text = ex.Message +
                "\n\nCheck %LOCALAPPDATA%\\unisona\\logs\\desktop.log, then reopen the app.";
            RetryHint.Visibility = Visibility.Visible;
        }
    }

    private async System.Threading.Tasks.Task InitWebViewAsync(string url)
    {
        var userData = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "unisona", "webview2");
        Directory.CreateDirectory(userData);

        var env = await CoreWebView2Environment.CreateAsync(null, userData);
        await Web.EnsureCoreWebView2Async(env);

        var core = Web.CoreWebView2;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = false; // no Ctrl+F/print browser UI
        core.Settings.IsPasswordAutosaveEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = true;     // copy/paste/inspect stay useful
        // No white flash before the page paints its dark ground.
        Web.DefaultBackgroundColor = System.Drawing.Color.FromArgb(0xFF, 0x0A, 0x0E, 0x14);

        // Links that ask for a new window (target=_blank, window.open) go to the real
        // browser — the app window stays a single-purpose cockpit, never a tab host.
        core.NewWindowRequested += (_, args) =>
        {
            args.Handled = true;
            OpenExternally(args.Uri);
        };
        // The page can ask to close (heartbeat/logout) — honor it as a window close.
        core.WindowCloseRequested += (_, _) => Dispatcher.Invoke(Close);
        Web.NavigationCompleted += OnNavigationCompleted;

        Web.Source = new Uri(url);
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (_revealed) return;
        _revealed = true;
        Web.Visibility = Visibility.Visible;
        Splash.Visibility = Visibility.Collapsed;
        Title = "Unisona";
    }

    private static void OpenExternally(string uri)
    {
        try
        {
            if (uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(uri) { UseShellExecute = true });
            }
        }
        catch (Exception ex) { Log.Write($"open-external failed: {ex.Message}"); }
    }

    // ── Shutdown ─────────────────────────────────────────────────────────────────
    private void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        SaveBounds();
        StopCore();
    }

    public void StopCore() => _core.Stop();

    // ── Window bounds persistence ────────────────────────────────────────────────
    private static string BoundsPath() => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "unisona", "shell-window.json");

    private record Bounds(double Left, double Top, double Width, double Height, bool Maximized);

    private void RestoreWindowBounds()
    {
        try
        {
            if (!File.Exists(BoundsPath())) return;
            var b = JsonSerializer.Deserialize<Bounds>(File.ReadAllText(BoundsPath()));
            if (b is null) return;
            // Only restore if the saved rect still lands on a visible virtual screen.
            if (b.Width >= MinWidth && b.Height >= MinHeight &&
                b.Left + b.Width > SystemParameters.VirtualScreenLeft + 40 &&
                b.Top + b.Height > SystemParameters.VirtualScreenTop + 40)
            {
                WindowStartupLocation = WindowStartupLocation.Manual;
                Left = b.Left; Top = b.Top; Width = b.Width; Height = b.Height;
            }
            if (b.Maximized) WindowState = WindowState.Maximized;
        }
        catch (Exception ex) { Log.Write($"restore-bounds: {ex.Message}"); }
    }

    private void SaveBounds()
    {
        try
        {
            var r = RestoreBoundsRect(); // normal (un-maximized) rect
            var b = new Bounds(r.Left, r.Top, r.Width, r.Height, WindowState == WindowState.Maximized);
            Directory.CreateDirectory(Path.GetDirectoryName(BoundsPath())!);
            File.WriteAllText(BoundsPath(), JsonSerializer.Serialize(b));
        }
        catch (Exception ex) { Log.Write($"save-bounds: {ex.Message}"); }
    }

    private Rect RestoreBoundsRect() =>
        WindowState == WindowState.Normal
            ? new Rect(Left, Top, Width, Height)
            : base.RestoreBounds; // WPF tracks the pre-maximize rect for us

    [DllImport("dwmapi.dll", PreserveSig = true)]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
}
