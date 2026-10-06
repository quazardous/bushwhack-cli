@echo off
rem Windows counterpart of bin/bushwhack, from any folder. The compiled CLI when setup.ps1
rem built it (packages\daemon\dist): it needs nothing but node, which Smart App Control lets
rem run. Otherwise the TypeScript sources, through tsx (setup.ps1 -Dev): tsx runs esbuild.exe,
rem an unsigned binary Smart App Control blocks.
setlocal
set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
if exist "%ROOT%\packages\daemon\dist\cli.js" (
  node "%ROOT%\packages\daemon\dist\cli.js" %*
  exit /b
)
set "TSX=%ROOT:\=/%/node_modules/tsx/dist/esm/index.mjs"
node --conditions=bushwhack-src --import "file:///%TSX%" "%ROOT%\packages\daemon\src\cli.ts" %*
