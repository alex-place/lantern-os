using System;
using System.IO;

namespace Unisona.Shell;

/// <summary>Best-effort rolling log next to the launcher's own desktop.log.</summary>
internal static class Log
{
    private static readonly object Gate = new();
    private static readonly string LogPath = BuildPath();

    private static string BuildPath()
    {
        var dir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "unisona", "logs");
        try { Directory.CreateDirectory(dir); } catch { /* best-effort */ }
        return Path.Combine(dir, "shell.log");
    }

    public static void Write(string message)
    {
        try
        {
            lock (Gate)
                File.AppendAllText(LogPath, $"{DateTime.Now:HH:mm:ss} [shell] {message}{Environment.NewLine}");
        }
        catch { /* never let logging break the app */ }
    }
}
