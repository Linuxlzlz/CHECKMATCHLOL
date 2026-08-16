# Genera el logo de CheckMatchLoL como JPG, sin dependencias externas.
#
# Concepto: la marca de verificación dibujada como una BARRA DE ERROR. Debajo del
# trazo va la línea del intervalo con sus dos topes y el punto estimado en rojo,
# corrido del centro. Es la firma visual del proyecto: nada se afirma sin su
# intervalo, y el punto casi nunca cae donde uno querría.
#
# Lo que evita que parezca vector generado:
#   - El trazo tiene ancho variable, calculado punto a punto: engorda en el
#     vértice y termina en punta fina, como una pincelada real.
#   - Desregistro de tinta: la capa roja va corrida unos píxeles, como una
#     serigrafía mal calzada. Ninguna herramienta automática comete ese "error".
#   - Grano sobre todo el lienzo, con semilla fija para que sea reproducible.
#
#   powershell -ExecutionPolicy Bypass -File tools\logo.ps1

Add-Type -AssemblyName System.Drawing

$outDir = Join-Path (Split-Path -Parent $PSScriptRoot) "assets\brand"
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

$S = 1024
$rand = New-Object System.Random 20260816   # semilla fija: mismo grano siempre

$paper = [System.Drawing.Color]::FromArgb(255, 240, 233, 218)
$ink   = [System.Drawing.Color]::FromArgb(255, 24, 30, 42)
$red   = [System.Drawing.Color]::FromArgb(255, 208, 62, 44)

# --- centro del trazo, con sus medios anchos ------------------------------
# Bajada corta y subida larga: la asimetría es lo que lo hace legible a 32 px.
$spine = @(
  @(232,452,13), @(288,516,21), @(342,586,29), @(392,650,36), @(438,712,40),
  @(500,626,35), @(566,536,29), @(636,442,22), @(706,348,15), @(772,256,8), @(818,196,2)
)

function Get-StrokePolygon($pts, $jitter) {
  $n = $pts.Count
  $left = New-Object System.Collections.ArrayList
  $right = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $n; $i++) {
    $p = $pts[$i]
    $prev = $pts[[Math]::Max(0, $i - 1)]
    $next = $pts[[Math]::Min($n - 1, $i + 1)]
    $dx = $next[0] - $prev[0]
    $dy = $next[1] - $prev[1]
    $len = [Math]::Sqrt($dx * $dx + $dy * $dy)
    if ($len -eq 0) { $len = 1 }
    # normal unitaria a la dirección local
    $nx = -$dy / $len
    $ny = $dx / $len
    $w = $p[2] + $jitter[$i]
    [void]$left.Add((New-Object System.Drawing.PointF(($p[0] + $nx * $w), ($p[1] + $ny * $w))))
    [void]$right.Add((New-Object System.Drawing.PointF(($p[0] - $nx * $w), ($p[1] - $ny * $w))))
  }
  $poly = New-Object System.Collections.ArrayList
  foreach ($q in $left) { [void]$poly.Add($q) }
  for ($i = $right.Count - 1; $i -ge 0; $i--) { [void]$poly.Add($right[$i]) }
  return , $poly.ToArray([System.Drawing.PointF])
}

# Irregularidad del pincel: pequeña, pero suficiente para que ningún borde quede
# matemáticamente paralelo a su opuesto.
$jitter = @()
foreach ($p in $spine) { $jitter += ($rand.NextDouble() * 3.4 - 1.7) }
$poly = Get-StrokePolygon $spine $jitter

$bmp = New-Object System.Drawing.Bitmap $S, $S
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear($paper)

$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddClosedCurve($poly, 0.28)
# En un vértice cerrado el borde interno se cruza consigo mismo. Con la regla de
# relleno alternada eso abre un hueco justo en la punta del check; con Winding se
# rellena como corresponde.
$path.FillMode = [System.Drawing.Drawing2D.FillMode]::Winding

# --- capa roja corrida: la serigrafía mal calzada -------------------------
# El desvío va hacia la IZQUIERDA a propósito. Hacia abajo y a la derecha se lee
# como sombra paralela, que es el recurso más visto que existe; hacia el otro
# lado se lee como lo que es, una plancha mal calzada.
$st = $g.Save()
$g.TranslateTransform(-19, 16)
$g.RotateTransform(1.1, [System.Drawing.Drawing2D.MatrixOrder]::Prepend)
$brushRed = New-Object System.Drawing.SolidBrush $red
$g.FillPath($brushRed, $path)
$g.Restore($st)

# --- barra de error: topes del intervalo y punto estimado ------------------
$barY = 826
$x0 = 176
$x1 = 858
$inkBrush = New-Object System.Drawing.SolidBrush $ink
$g.FillRectangle($inkBrush, $x0, ($barY - 5), ($x1 - $x0), 10)         # la línea
$g.FillRectangle($inkBrush, $x0, ($barY - 36), 11, 73)                 # tope izquierdo
$g.FillRectangle($inkBrush, ($x1 - 11), ($barY - 29), 11, 59)          # tope derecho (más bajo: a mano)
$g.FillEllipse($brushRed, 604, ($barY - 28), 56, 56)                   # el punto, corrido

# --- tinta principal encima ------------------------------------------------
$g.FillPath($inkBrush, $path)

# --- grano de papel --------------------------------------------------------
for ($i = 0; $i -lt 7000; $i++) {
  $x = $rand.Next(0, $S)
  $y = $rand.Next(0, $S)
  $a = $rand.Next(6, 20)
  $c = if ($rand.NextDouble() -gt 0.42) {
    [System.Drawing.Color]::FromArgb($a, 20, 24, 34)
  } else {
    [System.Drawing.Color]::FromArgb($a, 255, 252, 244)
  }
  $b = New-Object System.Drawing.SolidBrush $c
  $g.FillRectangle($b, $x, $y, $rand.Next(1, 3), $rand.Next(1, 3))
  $b.Dispose()
}

$g.Dispose()

# --- exportar en los tamaños que se usan -----------------------------------
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
  Where-Object { $_.MimeType -eq 'image/jpeg' }
$params = New-Object System.Drawing.Imaging.EncoderParameters 1
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
  [System.Drawing.Imaging.Encoder]::Quality, [long]95)

foreach ($size in 1024, 512, 400, 180, 64, 32) {
  $out = New-Object System.Drawing.Bitmap $size, $size
  $gg = [System.Drawing.Graphics]::FromImage($out)
  $gg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $gg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $gg.DrawImage($bmp, 0, 0, $size, $size)
  $gg.Dispose()
  $file = Join-Path $outDir ("checkmatch-logo-{0}.jpg" -f $size)
  $out.Save($file, $codec, $params)
  $out.Dispose()
  Write-Host "escrito: $file"
}

$bmp.Dispose()
