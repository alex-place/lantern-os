REM Lantern OS Orchestration Launcher
REM Silent VBScript wrapper to execute the orchestration batch file

Set objShell = CreateObject("WScript.Shell")
strBatchFile = WScript.ScriptFullName
strPath = Left(strBatchFile, InStrRev(strBatchFile, "\") - 1)
strCmdFile = strPath & "\RUN-ORCHESTRATION.bat"

REM Execute the batch file
objShell.Run strCmdFile, 1, True

REM Display completion message
WScript.Echo "Lantern OS Orchestration Complete" & vbCrLf & "Check the output window for results."
