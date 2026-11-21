; Installing TSPS Admin also installs the TSPS client (RSPSApp/tsps-desktop-client), bundled by build.mjs.
!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Installing the TSPS client..."
  ExecWait '"$INSTDIR\tsps-client-setup.exe" /S' $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION|MB_OK "The TSPS client didn't install (code $0). Run $INSTDIR\tsps-client-setup.exe to install it."
  ${EndIf}
!macroend
