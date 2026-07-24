using System.Windows;
using System.Windows.Threading;

namespace Unisona.Shell;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // A crash in the shell should never leave an orphaned Core node process behind.
        DispatcherUnhandledException += (_, args) =>
        {
            Log.Write($"unhandled: {args.Exception}");
            (MainWindow as MainWindow)?.StopCore();
            MessageBox.Show(
                "Unisona hit an unexpected error and needs to close.\n\n" + args.Exception.Message,
                "Unisona", MessageBoxButton.OK, MessageBoxImage.Error);
            args.Handled = true;
            Shutdown(1);
        };
    }
}
