; Hooks of the Windows installer (NSIS), named in tauri.bundle.conf.json (bundle.windows.nsis.installerHooks).
;
; The session daemon, norend.exe, sits next to noren.exe and is left running when the window of the
; app closes, so that the shells in it survive. Windows keeps the file of a running program open and
; refuses to replace or remove it, so the installer (and the uninstaller) must stop the daemon
; before they touch the files. Whatever shells were open in it end with it: an update replaces the
; program they run under.
;
; In order:
;  1. The app first. Closing the window leaves noren.exe running in the tray, and the question
;     "Noren is running, close it?" (CheckIfAppIsRunning, which the installer asks anyway a moment
;     after this hook) is the one a person can answer Cancel to: that must come before anything
;     ends, so a cancelled update finds its sessions alive.
;  2. `norend.exe --stop`: the daemon ends its sessions, exits, and the command returns when its
;     endpoint is free. Nothing running there is not an error. Hidden, and its exit code is not
;     looked at: what matters is whether the file is still held.
;  3. Whatever still holds norend.exe after that (a daemon that hung, or one that does not
;     understand --stop) is found by the path of the file and closed the same way the app is.

!macro NORENDStop
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  ${If} ${FileExists} "$INSTDIR\norend.exe"
    DetailPrint "Stopping the Noren session daemon"
    nsExec::Exec '"$INSTDIR\norend.exe" --stop'
    Pop $0
    !insertmacro CheckIfAppIsRunning "$INSTDIR\norend.exe" "Noren session daemon"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro NORENDStop
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro NORENDStop
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
