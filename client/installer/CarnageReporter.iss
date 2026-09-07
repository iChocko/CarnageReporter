; Instalador de CarnageReporter (Fase B5).
;
; Se compila con Inno Setup 6 (https://jrsoftware.org/isinfo.php):
;   iscc client/installer/CarnageReporter.iss
;
; En CI (.github/workflows/build-and-release.yml) este paso corre DESPUÉS de
; "npm run build": el .exe portable (client/dist/CarnageReporter.exe) ya
; existe, este script solo lo empaqueta en un instalador — no compila nada.
;
; MyAppVersion es metadata cosmética para "Programas y características" de
; Windows: actualízala junto con client/package.json en cada release. La
; fuente de verdad de la versión real que corre es el propio .exe (--version),
; no este número.

#define MyAppName "CarnageReporter"
#define MyAppVersion "1.7.0"
#define MyAppPublisher "iChocko"
#define MyAppURL "https://github.com/iChocko/CarnageReporter"
#define MyAppExeName "CarnageReporter.exe"

[Setup]
; GUID FIJO — no cambiar nunca entre releases. Es como Windows identifica
; "es la misma app, una versión nueva" en vez de instalarla como si fuera
; otro programa cada vez.
AppId={{AA35BE50-E089-45CF-AAE3-8838E03AC76E}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
; Nada de admin: se instala solo para el usuario actual, en la misma zona
; ({localappdata}) donde el cliente ya escribe settings/log/spool desde la
; Fase B3. Evita el UAC prompt y mantiene todo bajo el perfil del jugador.
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\CarnageReporter
DefaultGroupName=CarnageReporter
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=CarnageReporter-Setup
Compression=lzma
SolidCompression=yes
WizardStyle=modern
; El ejecutable aún no está firmado digitalmente (ver docs/release-signing.md):
; SmartScreen se queja igual que con el .exe portable. Es esperado por ahora.
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Files]
Source: "..\dist\CarnageReporter.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\CarnageReporter"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,CarnageReporter}"; Filename: "{uninstallexe}"

[Tasks]
Name: "startupicon"; Description: "Iniciar con Windows"; GroupDescription: "Opciones adicionales:"; Flags: unchecked

[Run]
; Con la tarea marcada, registra el arranque automático con el propio
; mecanismo del cliente (clave Run de HKCU + .vbs invisible, Fase B3/B4) en
; vez de un acceso directo aparte que se desincronizaría del menú interactivo.
Filename: "{app}\{#MyAppExeName}"; Parameters: "--enable-autostart"; Tasks: startupicon; Flags: runhidden
; Ofrece abrir la app en modo normal (interactivo) al terminar de instalar.
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,CarnageReporter}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Limpia el arranque automático al desinstalar, se haya marcado la tarea o
; no (--disable-autostart no truena si no había nada que desactivar).
Filename: "{app}\{#MyAppExeName}"; Parameters: "--disable-autostart"; RunOnceId: "DisableAutostart"; Flags: runhidden
