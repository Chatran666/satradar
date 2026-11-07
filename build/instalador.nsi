; Instalador de SatRadar (se compila con makensis)
Unicode true
!include "MUI2.nsh"
!ifndef VERSION
  !define VERSION "2.0.0"
!endif
!ifndef ORIGEN
  !define ORIGEN "..\dist\SatRadar-win32-x64"
!endif
!ifndef SALIDA
  !define SALIDA "..\dist\SatRadar-Setup-${VERSION}.exe"
!endif
!ifndef ICONO
  !define ICONO "..\app\icono.ico"
!endif
!define CLAVE "Software\Microsoft\Windows\CurrentVersion\Uninstall\SatRadar"

Name "SatRadar ${VERSION}"
OutFile "${SALIDA}"
InstallDir "$LOCALAPPDATA\Programs\SatRadar"
InstallDirRegKey HKCU "Software\SatRadar" "Carpeta"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "SatRadar ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "SatRadar"
VIAddVersionKey "FileDescription" "Instalador de SatRadar"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "Mariano"
VIAddVersionKey "LegalCopyright" "Mariano"

!define MUI_ICON "${ICONO}"
!define MUI_UNICON "${ICONO}"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\SatRadar.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Abrir SatRadar"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Spanish"

Section "SatRadar" Principal
  ; Si está abierta (por ejemplo al actualizar), se cierra
  nsExec::Exec 'taskkill /IM SatRadar.exe /F'
  Sleep 800
  SetOutPath "$INSTDIR"
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  File /r "${ORIGEN}\*.*"
  WriteUninstaller "$INSTDIR\Desinstalar SatRadar.exe"
  CreateShortcut "$DESKTOP\SatRadar.lnk" "$INSTDIR\SatRadar.exe"
  CreateShortcut "$SMPROGRAMS\SatRadar.lnk" "$INSTDIR\SatRadar.exe"
  WriteRegStr HKCU "Software\SatRadar" "Carpeta" "$INSTDIR"
  WriteRegStr HKCU "${CLAVE}" "DisplayName" "SatRadar"
  WriteRegStr HKCU "${CLAVE}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${CLAVE}" "Publisher" "Mariano"
  WriteRegStr HKCU "${CLAVE}" "DisplayIcon" "$INSTDIR\SatRadar.exe"
  WriteRegStr HKCU "${CLAVE}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${CLAVE}" "UninstallString" '"$INSTDIR\Desinstalar SatRadar.exe"'
  WriteRegDWORD HKCU "${CLAVE}" "NoModify" 1
  WriteRegDWORD HKCU "${CLAVE}" "NoRepair" 1
  WriteRegDWORD HKCU "${CLAVE}" "EstimatedSize" 290000
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /IM SatRadar.exe /F'
  Sleep 800
  Delete "$DESKTOP\SatRadar.lnk"
  Delete "$SMPROGRAMS\SatRadar.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${CLAVE}"
  DeleteRegKey HKCU "Software\SatRadar"
  ; Los ajustes y datos guardados (AppData\Roaming\SatRadar) se conservan
SectionEnd
