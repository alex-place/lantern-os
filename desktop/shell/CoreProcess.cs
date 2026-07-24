using System;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Unisona.Shell;

/// <summary>
/// Boots the ONE Convergence Core in embed mode (ADR-0014 G1: the shell replaces only
/// the window; all Core boot / hardening / token / auto-update stay in launcher.js).
///
/// Two backends, auto-detected:
///   • Packaged — a sibling <c>unisona-core.exe</c> (the Node SEA: runtime + launcher +
///     Core in one binary). No Node needed on the user's machine.
///   • Dev — <c>node launcher.js --embed</c> from the repo.
///
/// The tokened endpoint comes back over a file handshake (LOCALAPPDATA\unisona\endpoint.json)
/// because the packaged Core is GUI-subsystem and its stdout pipe may be unwired; the
/// stdout marker is honoured too as a fast path in dev.
/// </summary>
internal sealed class CoreProcess
{
    private Process? _proc;
    public event Action<string>? Status;

    private static string EndpointFile => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "unisona", "endpoint.json");

    /// <summary>Starts the Core and resolves to the tokened URL to load in WebView2.</summary>
    public async Task<string> StartAsync(TimeSpan timeout, CancellationToken ct)
    {
        // Clear any stale handshake from a previous run BEFORE we spawn.
        try { File.Delete(EndpointFile); } catch { /* ignore */ }

        var (fileName, workingDir, args) = ResolveBackend();
        Log.Write($"core: {fileName} [{string.Join(' ', args)}] cwd={workingDir}");
        Report("Starting the Core…");

        var psi = new ProcessStartInfo
        {
            FileName = fileName,
            WorkingDirectory = workingDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);

        var stdoutReady = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);

        _proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
        _proc.OutputDataReceived += (_, e) =>
        {
            if (e.Data is null) return;
            Log.Write($"core.out: {e.Data}");
            const string marker = "UNISONA_READY ";
            var i = e.Data.IndexOf(marker, StringComparison.Ordinal);
            if (i >= 0) stdoutReady.TrySetResult(e.Data[(i + marker.Length)..].Trim());
            else if (e.Data.Contains("Binding:", StringComparison.Ordinal)) Report("Waiting for the reasoning engine…");
        };
        _proc.ErrorDataReceived += (_, e) => { if (e.Data is not null) Log.Write($"core.err: {e.Data}"); };

        _proc.Start();
        _proc.BeginOutputReadLine();
        _proc.BeginErrorReadLine();

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(timeout);

        // Whichever handshake resolves first wins: the endpoint file (reliable, packaged)
        // or the stdout marker (fast, dev). If the Core dies first, surface that.
        var fileTask = WaitForEndpointFileAsync(_proc, timeoutCts.Token);
        var exitTask = WaitForUnexpectedExitAsync(_proc, timeoutCts.Token);
        var done = await Task.WhenAny(fileTask, stdoutReady.Task, exitTask).ConfigureAwait(false);

        var url = await done.ConfigureAwait(false); // rethrows if this was the exit/timeout task
        Report("Loading your cockpit…");
        Log.Write($"core: ready at {url}");
        return url;
    }

    private static async Task<string> WaitForEndpointFileAsync(Process proc, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                if (File.Exists(EndpointFile))
                {
                    using var fs = new FileStream(EndpointFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                    var ep = JsonSerializer.Deserialize<Endpoint>(fs);
                    // Match the pid we spawned so we never read a foreign/stale file.
                    if (ep is not null && !string.IsNullOrEmpty(ep.url) && ep.pid == proc.Id)
                        return ep.url!;
                }
            }
            catch { /* file mid-write or transient — retry */ }
            await Task.Delay(150, ct).ConfigureAwait(false);
        }
        throw new TimeoutException("The Core did not become ready in time.");
    }

    private static async Task<string> WaitForUnexpectedExitAsync(Process proc, CancellationToken ct)
    {
        try { await proc.WaitForExitAsync(ct).ConfigureAwait(false); }
        catch (OperationCanceledException) { throw new TimeoutException("The Core did not become ready in time."); }
        throw new InvalidOperationException(
            $"The Core exited before it was ready (code {proc.ExitCode}). " +
            "See %LOCALAPPDATA%\\unisona\\logs\\desktop.log.");
    }

    private sealed class Endpoint
    {
        public string? url { get; set; }
        public int pid { get; set; }
        public int port { get; set; }
        public long ts { get; set; }
    }

    /// <summary>Tears down the launcher + Core process tree. Idempotent.</summary>
    public void Stop()
    {
        var proc = _proc;
        _proc = null;
        if (proc is null) return;
        try
        {
            if (!proc.HasExited)
            {
                using var kill = Process.Start(new ProcessStartInfo
                {
                    FileName = "taskkill",
                    Arguments = $"/PID {proc.Id} /T /F",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                });
                kill?.WaitForExit(3000);
            }
        }
        catch (Exception ex) { Log.Write($"core.stop: {ex.Message}"); }
        finally { try { proc.Dispose(); } catch { /* ignore */ } }
    }

    private void Report(string s) => Status?.Invoke(s);

    // ── Backend resolution ───────────────────────────────────────────────────────
    private (string fileName, string workingDir, string[] args) ResolveBackend()
    {
        // Packaged: the Node SEA sits beside the shell as unisona-core.exe.
        var coreExe = Path.Combine(AppContext.BaseDirectory, "unisona-core.exe");
        if (File.Exists(coreExe))
            return (coreExe, AppContext.BaseDirectory, new[] { "--embed" });

        // Dev: node launcher.js --embed from the repo.
        var launcher = FindLauncher()
            ?? throw new FileNotFoundException(
                "No Core backend found (unisona-core.exe or launcher.js). Set UNISONA_LAUNCHER.");
        var node = FindNode()
            ?? throw new FileNotFoundException("Node.js not found on PATH. Set UNISONA_NODE to node.exe.");
        return (node, Path.GetDirectoryName(launcher)!, new[] { Path.GetFileName(launcher), "--embed" });
    }

    private static string? FindLauncher()
    {
        var env = Environment.GetEnvironmentVariable("UNISONA_LAUNCHER");
        if (!string.IsNullOrWhiteSpace(env) && File.Exists(env)) return env;

        var beside = Path.Combine(AppContext.BaseDirectory, "resources", "app", "desktop", "launcher.js");
        if (File.Exists(beside)) return beside;

        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; i < 8 && dir is not null; i++, dir = dir.Parent)
        {
            var here = Path.Combine(dir.FullName, "launcher.js");
            if (File.Exists(here)) return here;
            var nested = Path.Combine(dir.FullName, "desktop", "launcher.js");
            if (File.Exists(nested)) return nested;
        }
        return null;
    }

    private static string? FindNode()
    {
        var env = Environment.GetEnvironmentVariable("UNISONA_NODE");
        if (!string.IsNullOrWhiteSpace(env) && File.Exists(env)) return env;

        foreach (var p in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            if (string.IsNullOrWhiteSpace(p)) continue;
            try
            {
                var exe = Path.Combine(p.Trim(), "node.exe");
                if (File.Exists(exe)) return exe;
            }
            catch { /* skip malformed PATH entries */ }
        }
        return "node";
    }
}
