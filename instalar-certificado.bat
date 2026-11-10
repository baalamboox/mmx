@echo off
title Instalador de Certificado SSL - Kortexa
cls
echo ============================================================
echo   REGISTRAR CERTIFICADO SSL DE KORTEXA (HTTPS LOCALHOST)
echo ============================================================
echo.
echo Presione cualquier tecla para registrar el certificado...
pause >nul

echo Instalando certificado en Entidades de Certificacion Raiz de Confianza...
certutil -addstore -user -f "ROOT" "%~dp0certs\cert.pem"

echo.
if %errorlevel% equ 0 (
    echo ============================================================
    echo [EXITO] Certificado registrado correctamente.
    echo Reinicie su navegador (Chrome/Edge) para ver el candado verde.
    echo ============================================================
) else (
    echo [AVISO] El proceso no se completo o fue cancelado.
)
echo.
pause
