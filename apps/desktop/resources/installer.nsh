!macro customInstall
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    ${IfNot} ${FileExists} "$newStartMenuLink"
      !insertmacro createMenuDirectory
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${EndIf}
  !endif

  ; The AppContainer-sandboxed GPU process must read the install dir (electron/electron#51761).
  nsExec::Exec `"$SYSDIR\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-2:(OI)(CI)(RX)"`
  Pop $0
!macroend
