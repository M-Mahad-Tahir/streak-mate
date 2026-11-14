' Starts Win Streak in the background (no window to close by accident).
' The app keeps running until you sign out or restart Windows.
' Output is written to winstreak-server.log in this folder.
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = appDir
' 0 = hidden window, False = do not wait
shell.Run "cmd.exe /c npm run dev -- --port 5173 --strictPort > winstreak-server.log 2>&1", 0, False
