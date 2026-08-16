# Genera el logo de CheckMatchLoL como JPG, sin dependencias externas.
#
# CONCEPTO
# La marca de verificación dibujada como una BARRA DE ERROR: el check es el trazo,
# y debajo va la línea del intervalo con sus dos topes y el punto estimado corrido
# del centro. Es la firma del proyecto — nada se afirma sin su intervalo, y el
# punto casi nunca cae donde uno querría.
#
# ESTÉTICA
# La del cliente de League y la de la propia página, que ya comparten paleta:
#   - Fondo tinta azulada, el mismo --bg del sitio, con un halo al centro.
#   - Oro Hextech con bisel: claro arriba, quemado abajo, como metal grabado.
#   - Marco de esquinas cortadas con el rombo del cliente arriba y abajo.
#   - El punto estimado es un hexágono en el azul de acento del sitio: en Hextech
#     el oro es la estructura y el cian/azul es lo que está vivo.
#
# QUÉ EVITA QUE PAREZCA VECTOR GENERADO
#   - Ancho de trazo variable calculado punto a punto: engorda en el vértice y
#     sale en punta. No hay dos bordes matemáticamente paralelos.
#   - Los dos topes de la barra tienen alturas distintas, y el marco lleva una
#     irregularidad mínima. Lo perfectamente simétrico se lee impreso por máquina.
#   - Grano fino sobre todo el lienzo, con semilla fija: reproducible byte a byte.
#
#   powershell -ExecutionPolicy Bypass -File tools\logo.ps1

Add-Type -AssemblyName System.Drawing

$outDir = Join-Path (Split-Path -Parent $PSScriptRoot) "assets\brand"
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

$S = 1024
$rand = New-Object System.Random 20260816   # semilla fija: mismo grano siempre

function C([int]$r, [int]$g, [int]$b, [int]$a = 255) {
  return [System.Drawing.Color]::FromArgb($a, $r, $g, $b)
}

# Paleta: la del sitio, que es la de Hextech.
$bgDeep   = C 8 11 18        # --bg del sitio, apenas más oscuro
$bgGlow   = C 22 33 58       # halo central, azul de sala de invocación
$goldLite = C 240 230 210    # #F0E6D2, el crema del cliente
$goldMid  = C 224 182 74     # --gold del sitio
$goldDark = C 120 90 40      # #785A28, oro quemado del borde
$accent   = C 77 163 255     # --accent del sitio
$accentHi = C 168 214 255

# Dos variantes, porque se usan distinto:
#   marco  -> icono del sitio y og:image, donde el cuadrado se ve entero.
#   avatar -> Twitter, que recorta en CÍRCULO. Las esquinas del marco caen fuera
#             del círculo inscrito, así que ahí el marco sobra y el trazo va más
#             grande para llenar el redondel.
function Render-Logo([bool]$withFrame, [double]$markScale) {

# --- lienzo y halo ---------------------------------------------------------
$bmp = New-Object System.Drawing.Bitmap $S, $S
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear($bgDeep)

$glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$glowPath.AddEllipse(-140, -60, ($S + 280), ($S + 200))
$glow = New-Object System.Drawing.Drawing2D.PathGradientBrush $glowPath
$glow.CenterPoint = New-Object System.Drawing.PointF(470, 430)
$glow.CenterColor = $bgGlow
$glow.SurroundColors = @($bgDeep)
$g.FillPath($glow, $glowPath)

# --- marco de esquinas cortadas -------------------------------------------
function Chamfered([int]$inset, [int]$cut) {
  $a = $inset
  $b = $S - $inset
  return , @(
    (New-Object System.Drawing.PointF(($a + $cut), $a)),
    (New-Object System.Drawing.PointF(($b - $cut), $a)),
    (New-Object System.Drawing.PointF($b, ($a + $cut))),
    (New-Object System.Drawing.PointF($b, ($b - $cut))),
    (New-Object System.Drawing.PointF(($b - $cut), $b)),
    (New-Object System.Drawing.PointF(($a + $cut), $b)),
    (New-Object System.Drawing.PointF($a, ($b - $cut))),
    (New-Object System.Drawing.PointF($a, ($a + $cut)))
  )
}

$brushDeep = New-Object System.Drawing.SolidBrush $bgDeep
$brushGold = New-Object System.Drawing.SolidBrush $goldMid
$brushDark = New-Object System.Drawing.SolidBrush $goldDark

if ($withFrame) {
  $penOuter = New-Object System.Drawing.Pen($goldDark, 7)
  $penInner = New-Object System.Drawing.Pen($goldMid, 2.5)
  $g.DrawPolygon($penOuter, (Chamfered 52 46))
  $g.DrawPolygon($penInner, (Chamfered 68 38))
}

# El rombo del cliente, arriba y abajo, montado sobre la línea del marco.
function Diamond($cx, $cy, $r, $brush) {
  $pts = @(
    (New-Object System.Drawing.PointF($cx, ($cy - $r))),
    (New-Object System.Drawing.PointF(($cx + $r), $cy)),
    (New-Object System.Drawing.PointF($cx, ($cy + $r))),
    (New-Object System.Drawing.PointF(($cx - $r), $cy))
  )
  $g.FillPolygon($brush, $pts)
}
if ($withFrame) {
  foreach ($cy in 52, 972) {
    Diamond 512 $cy 30 $brushDeep    # abre el hueco en la línea
    Diamond 512 $cy 22 $brushGold
    Diamond 512 $cy 10 $brushDeep
  }
}

# El trazo y la barra se dibujan sobre un lienzo escalado desde el centro.
$stMark = $g.Save()
$g.TranslateTransform(512, 512)
$g.ScaleTransform($markScale, $markScale)
$g.TranslateTransform(-512, -512)

# --- el trazo: línea central con medio ancho por punto ---------------------
# Bajada corta y subida larga: la asimetría es lo que lo hace legible a 32 px.
$spine = @(
  @(268,438,12), @(318,494,19), @(366,556,27), @(412,616,33), @(452,676,37),
  @(508,596,32), @(568,512,27), @(632,424,20), @(694,338,14), @(752,254,7), @(792,198,2)
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
    $nx = -$dy / $len      # normal unitaria a la dirección local
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

$jitter = @()
foreach ($p in $spine) { $jitter += ($rand.NextDouble() * 3.2 - 1.6) }
$poly = Get-StrokePolygon $spine $jitter

$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddClosedCurve($poly, 0.28)
# En un vértice cerrado el borde interno se cruza consigo mismo. Con relleno
# alternado eso abre un hueco en la punta del check; Winding lo llena bien.
$path.FillMode = [System.Drawing.Drawing2D.FillMode]::Winding

# --- barra de error, detrás del trazo --------------------------------------
$barY = 792
$x0 = 214
$x1 = 812
# La línea va en un oro intermedio: en oro quemado se perdía a 32 px y quedaban
# los dos topes flotando sin nada que los una.
$brushBar = New-Object System.Drawing.SolidBrush (C 168 128 56)
$g.FillRectangle($brushBar, $x0, ($barY - 4), ($x1 - $x0), 9)
$g.FillRectangle($brushGold, $x0, ($barY - 34), 10, 69)      # tope izquierdo
$g.FillRectangle($brushGold, ($x1 - 10), ($barY - 27), 10, 55) # derecho, más bajo

# El punto estimado: hexágono hextech, corrido del centro.
function Hexagon($cx, $cy, $r) {
  $pts = @()
  for ($i = 0; $i -lt 6; $i++) {
    $ang = [Math]::PI / 2 + $i * [Math]::PI / 3
    $pts += (New-Object System.Drawing.PointF(($cx + $r * [Math]::Cos($ang)), ($cy - $r * [Math]::Sin($ang))))
  }
  return , $pts
}
$hex = Hexagon 606 $barY 34
$hexGlow = New-Object System.Drawing.SolidBrush (C 77 163 255 46)
$g.FillPolygon($hexGlow, (Hexagon 606 $barY 52))
$g.FillPolygon((New-Object System.Drawing.SolidBrush $accent), $hex)
$g.FillPolygon((New-Object System.Drawing.SolidBrush $bgDeep), (Hexagon 606 $barY 17))
$penHex = New-Object System.Drawing.Pen($accentHi, 2)
$g.DrawPolygon($penHex, $hex)

# --- el trazo en oro biselado ----------------------------------------------
# Sombra quemada abajo y a la derecha, oro degradado encima: el metal grabado del
# cliente sale de esa diferencia entre el borde iluminado y el borde en sombra.
$st = $g.Save()
$g.TranslateTransform(7, 9)
$g.FillPath((New-Object System.Drawing.SolidBrush (C 60 44 18)), $path)
$g.Restore($st)

$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.PointF(300, 180)),
  (New-Object System.Drawing.PointF(640, 720)),
  $goldLite, $goldDark)
$blend = New-Object System.Drawing.Drawing2D.ColorBlend 4
$blend.Colors = @($goldLite, $goldMid, $goldMid, $goldDark)
$blend.Positions = @(0.0, 0.34, 0.68, 1.0)
$grad.InterpolationColors = $blend
$g.FillPath($grad, $path)

# Filo de luz sobre el canto superior, que es lo que termina de darle relieve.
$penEdge = New-Object System.Drawing.Pen((C 245 236 214 120), 2.2)
$g.DrawPath($penEdge, $path)

$g.Restore($stMark)

# --- grano ------------------------------------------------------------------
# Va sin escalar: el grano es del papel, no del dibujo.
for ($i = 0; $i -lt 7000; $i++) {
  $x = $rand.Next(0, $S)
  $y = $rand.Next(0, $S)
  $a = $rand.Next(5, 16)
  $c = if ($rand.NextDouble() -gt 0.5) { C 0 0 0 $a } else { C 190 205 235 $a }
  $b = New-Object System.Drawing.SolidBrush $c
  $g.FillRectangle($b, $x, $y, $rand.Next(1, 3), $rand.Next(1, 3))
  $b.Dispose()
}

$g.Dispose()
return $bmp

}   # fin Render-Logo

# --- exportar ---------------------------------------------------------------
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
  Where-Object { $_.MimeType -eq 'image/jpeg' }
$params = New-Object System.Drawing.Imaging.EncoderParameters 1
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
  [System.Drawing.Imaging.Encoder]::Quality, [long]95)

function Export-Sizes($bmp, $prefix, $sizes) {
  foreach ($size in $sizes) {
    $out = New-Object System.Drawing.Bitmap $size, $size
    $gg = [System.Drawing.Graphics]::FromImage($out)
    $gg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $gg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $gg.DrawImage($bmp, 0, 0, $size, $size)
    $gg.Dispose()
    $file = Join-Path $outDir ("{0}-{1}.jpg" -f $prefix, $size)
    $out.Save($file, $codec, $params)
    $out.Dispose()
    Write-Host "escrito: $file"
  }
}

$framed = Render-Logo $true 1.0
Export-Sizes $framed "checkmatch-logo" @(1024, 512, 400, 180, 64, 32)
$framed.Dispose()

# Sin marco y con el trazo más grande: pensado para el recorte circular.
$rand = New-Object System.Random 20260816   # mismo grano en las dos variantes
$avatar = Render-Logo $false 1.16
Export-Sizes $avatar "checkmatch-avatar" @(1024, 512, 400)
$avatar.Dispose()
