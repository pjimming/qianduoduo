' Hidden login bootstrap for the QianDuoDuo production Supervisor.
Option Explicit

Dim fso
Dim shell
Dim powerShellExe
Dim command
Dim exitCode
Dim logPath

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
logPath = "__LOG_PATH__"

powerShellExe = shell.ExpandEnvironmentStrings("%SystemRoot%") & _
  "\System32\WindowsPowerShell\v1.0\powershell.exe"
On Error Resume Next
shell.CurrentDirectory = "__PROJECT_ROOT__"
If Err.Number <> 0 Then
  LogMessage "cwd_error=" & Err.Number & " " & Err.Description
  WScript.Quit 2
End If

command = Quote(powerShellExe) & _
  " -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden" & _
  " -File " & Quote(".\scripts\production-host.ps1") & _
  " -Action bootstrap -Port __PORT__ -Root ""."" -TaskName ""__TASK_NAME__"""

' Window style 0 hides PowerShell. True keeps the one-shot task active so
' IgnoreNew prevents overlapping login bootstraps.
LogMessage "start command=" & command
exitCode = shell.Run(command, 0, True)
If Err.Number <> 0 Then
  LogMessage "run_error=" & Err.Number & " " & Err.Description
  WScript.Quit 3
End If
LogMessage "exit=" & exitCode
WScript.Quit exitCode

Function Quote(ByVal value)
  Quote = """" & Replace(value, """", """""") & """"
End Function

Sub LogMessage(ByVal message)
  Dim stream
  On Error Resume Next
  Set stream = fso.OpenTextFile(logPath, 8, True, -1)
  If Err.Number = 0 Then
    stream.WriteLine Now & " " & message
    stream.Close
  End If
End Sub
