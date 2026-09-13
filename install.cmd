@echo off
rem install.cmd -- thin Windows entry point. Locates Node and hands off to
rem scripts\install.js, which does all real work (slash commands, hooks,
rem Codex MCP registration/skills -- see scripts\install.js --help).
setlocal

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH.
  echo Install it from https://nodejs.org/en/download ^(LTS, v22 or newer^),
  echo or on Windows: winget install OpenJS.NodeJS.LTS
  echo Then re-run install.cmd.
  exit /b 1
)

node "%~dp0scripts\install.js" %*
exit /b %errorlevel%
