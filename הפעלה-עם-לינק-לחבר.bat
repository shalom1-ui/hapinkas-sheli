@echo off
title HaPinkas Sheli - Starting
cd /d "%~dp0"
echo Starting the server...
start "SERVER - do not close this window" cmd /k "node src\server.js"
timeout /t 3 /nobreak >nul
echo Starting the share link...
start "LINK FOR FRIEND - do not close this window" cmd /k "npx.cmd localtunnel --port 3000 --subdomain hapinkas-sheli"
echo.
echo Two windows opened: one for the server, one for the share link.
echo In the "LINK FOR FRIEND" window, look for a line that says:  your url is: https://...
echo That address is what you send to your friend.
echo.
echo You can close THIS window now - but keep the other two windows open.
pause
