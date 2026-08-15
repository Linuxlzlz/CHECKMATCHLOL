# Servidor estático mínimo para previsualizar el sitio.
#
# Los módulos ES no cargan desde file://, hace falta HTTP. Este script no
# necesita Node ni Python: usa HttpListener de .NET, que ya viene con Windows.
#
#   powershell -ExecutionPolicy Bypass -File tools\serve.ps1
#   luego abrir http://localhost:8099/

param([int]$Port = 8099)

$root = Split-Path -Parent $PSScriptRoot
$prefix = "http://localhost:$Port/"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
try { $listener.Start() }
catch { Write-Host "No se pudo abrir $prefix : $($_.Exception.Message)" -ForegroundColor Red; exit 1 }

Write-Host "Sirviendo $root en $prefix  (Ctrl+C para cortar)" -ForegroundColor Green

$mime = @{
  ".html" = "text/html; charset=utf-8"; ".js" = "text/javascript; charset=utf-8"
  ".css"  = "text/css; charset=utf-8";  ".json" = "application/json; charset=utf-8"
  ".svg"  = "image/svg+xml"; ".png" = "image/png"; ".ico" = "image/x-icon"
  ".md"   = "text/plain; charset=utf-8"
}

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $path = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
    if ($path -eq "/") { $path = "/index.html" }

    $rel = ($path -replace "^/", "") -replace "/", "\"
    $file = Join-Path $root $rel

    # No servir nada fuera de la raíz del proyecto.
    $full = [System.IO.Path]::GetFullPath($file)
    if (-not $full.StartsWith([System.IO.Path]::GetFullPath($root))) {
      $ctx.Response.StatusCode = 403; $ctx.Response.Close(); continue
    }

    if (Test-Path $full -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      $ct = $mime[$ext]; if (-not $ct) { $ct = "application/octet-stream" }
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $ctx.Response.ContentType = $ct
      $ctx.Response.StatusCode = 200
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
      $b = [System.Text.Encoding]::UTF8.GetBytes("404: $path")
      $ctx.Response.OutputStream.Write($b, 0, $b.Length)
    }
    $ctx.Response.Close()
  } catch { }
}
