# Genera el banner de Twitter (1500x500) de CheckMatchLoL.
#
# Misma estética que el logo: tinta azulada, oro Hextech con bisel, rombos y
# esquinas cortadas del cliente de League, y la paleta exacta de la página.
#
# DOS TRAMPAS DEL FORMATO, QUE SON LAS QUE DEFINEN LA COMPOSICIÓN
#
#  1. El avatar se monta sobre la esquina INFERIOR IZQUIERDA del banner. Todo lo
#     que quede ahí abajo a la izquierda se pierde. Por eso el trazo arranca
#     recién en x=344 y el bloque de texto en x=650.
#  2. En pantallas angostas Twitter recorta por los lados. Nada importante toca
#     los primeros ni los últimos ~180 px.
#
#   powershell -ExecutionPolicy Bypass -File tools\banner.ps1

Add-Type -AssemblyName System.Drawing

$outDir = Join-Path (Split-Path -Parent $PSScriptRoot) "assets\brand"
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

$W = 1500
$H = 500
$rand = New-Object System.Random 20260816

function C([int]$r, [int]$g, [int]$b, [int]$a = 255) {
  return [System.Drawing.Color]::FromArgb($a, $r, $g, $b)
}

$bgDeep   = C 8 11 18
$bgGlow   = C 22 33 58
$goldLite = C 240 230 210
$goldMid  = C 224 182 74
$goldDark = C 120 90 40
$accent   = C 77 163 255
$accentHi = C 168 214 255
$cream    = C 205 198 182

$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear($bgDeep)

# --- halo, corrido a la derecha para no competir con el avatar -------------
$glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$glowPath.AddEllipse(-200, -420, ($W + 400), ($H + 840))
$glow = New-Object System.Drawing.Drawing2D.PathGradientBrush $glowPath
$glow.CenterPoint = New-Object System.Drawing.PointF(880, 210)
$glow.CenterColor = $bgGlow
$glow.SurroundColors = @($bgDeep)
$g.FillPath($glow, $glowPath)

# --- retícula hexagonal: la textura hextech, apenas insinuada --------------
$penHex = New-Object System.Drawing.Pen((C 224 182 74 13), 1.4)
$r = 46
$dx = [Math]::Sqrt(3) * $r
$dy = 1.5 * $r
for ($row = -1; $row -lt [int]($H / $dy) + 2; $row++) {
  for ($col = -1; $col -lt [int]($W / $dx) + 2; $col++) {
    $cx = $col * $dx + $(if ($row % 2 -ne 0) { $dx / 2 } else { 0 })
    $cy = $row * $dy
    $pts = @()
    for ($i = 0; $i -lt 6; $i++) {
      $ang = [Math]::PI / 2 + $i * [Math]::PI / 3
      $pts += (New-Object System.Drawing.PointF(($cx + $r * [Math]::Cos($ang)), ($cy - $r * [Math]::Sin($ang))))
    }
    $g.DrawPolygon($penHex, $pts)
  }
}

# --- esquinas cortadas, como el marco del logo -----------------------------
$penFrame = New-Object System.Drawing.Pen($goldDark, 3)
$m = 26; $len = 96; $cut = 34
foreach ($corner in @(@(0,0,1,1), @(1,0,-1,1), @(0,1,1,-1), @(1,1,-1,-1))) {
  $ox = if ($corner[0] -eq 0) { $m } else { $W - $m }
  $oy = if ($corner[1] -eq 0) { $m } else { $H - $m }
  $sx = $corner[2]; $sy = $corner[3]
  $g.DrawLine($penFrame, ($ox + $sx * $cut), $oy, ($ox + $sx * ($cut + $len)), $oy)
  $g.DrawLine($penFrame, $ox, ($oy + $sy * $cut), $ox, ($oy + $sy * ($cut + $len)))
  $g.DrawLine($penFrame, ($ox + $sx * $cut), $oy, $ox, ($oy + $sy * $cut))
}

# --- el trazo: mismo perfil de ancho variable que el logo ------------------
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
    $ddx = $next[0] - $prev[0]; $ddy = $next[1] - $prev[1]
    $len2 = [Math]::Sqrt($ddx * $ddx + $ddy * $ddy); if ($len2 -eq 0) { $len2 = 1 }
    $nx = -$ddy / $len2; $ny = $ddx / $len2
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
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddClosedCurve((Get-StrokePolygon $spine $jitter), 0.28)
$path.FillMode = [System.Drawing.Drawing2D.FillMode]::Winding

# La marca se dibuja en el espacio de 1024 del logo y se lleva a su lugar:
# centro del dibujo (530,512) -> (470,232), a escala 0.48.
$scale = 0.48
$st = $g.Save()
$g.TranslateTransform(470, 232)
$g.ScaleTransform($scale, $scale)
$g.TranslateTransform(-530, -512)

$brushGold = New-Object System.Drawing.SolidBrush $goldMid
$brushBar  = New-Object System.Drawing.SolidBrush (C 168 128 56)
$barY = 792; $x0 = 214; $x1 = 812
$g.FillRectangle($brushBar, $x0, ($barY - 4), ($x1 - $x0), 9)
$g.FillRectangle($brushGold, $x0, ($barY - 34), 10, 69)
$g.FillRectangle($brushGold, ($x1 - 10), ($barY - 27), 10, 55)

function Hexagon($cx, $cy, $rr) {
  $pts = @()
  for ($i = 0; $i -lt 6; $i++) {
    $ang = [Math]::PI / 2 + $i * [Math]::PI / 3
    $pts += (New-Object System.Drawing.PointF(($cx + $rr * [Math]::Cos($ang)), ($cy - $rr * [Math]::Sin($ang))))
  }
  return , $pts
}
$g.FillPolygon((New-Object System.Drawing.SolidBrush (C 77 163 255 46)), (Hexagon 606 $barY 52))
$g.FillPolygon((New-Object System.Drawing.SolidBrush $accent), (Hexagon 606 $barY 34))
$g.FillPolygon((New-Object System.Drawing.SolidBrush $bgDeep), (Hexagon 606 $barY 17))
$g.DrawPolygon((New-Object System.Drawing.Pen($accentHi, 2)), (Hexagon 606 $barY 34))

$stShadow = $g.Save()
$g.TranslateTransform(7, 9)
$g.FillPath((New-Object System.Drawing.SolidBrush (C 60 44 18)), $path)
$g.Restore($stShadow)

$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.PointF(300, 180)), (New-Object System.Drawing.PointF(640, 720)),
  $goldLite, $goldDark)
$blend = New-Object System.Drawing.Drawing2D.ColorBlend 4
$blend.Colors = @($goldLite, $goldMid, $goldMid, $goldDark)
$blend.Positions = @(0.0, 0.34, 0.68, 1.0)
$grad.InterpolationColors = $blend
$g.FillPath($grad, $path)
$g.DrawPath((New-Object System.Drawing.Pen((C 245 236 214 120), 2.2)), $path)
$g.Restore($st)

# --- tipografía: mayúsculas con tracking, como los títulos del cliente -----
# DrawString no sabe de tracking, así que se dibuja letra por letra midiendo el
# avance de cada una. Es lo que separa un título con aire de uno apretado.
$fmt = [System.Drawing.StringFormat]::GenericTypographic
function Draw-Tracked($text, $font, $brush, $x, $y, $tracking) {
  $cx = $x
  foreach ($ch in $text.ToCharArray()) {
    $s = [string]$ch
    if ($s -eq ' ') { $cx += $font.Size * 0.40 + $tracking; continue }
    $script:g.DrawString($s, $font, $brush, $cx, $y, $fmt)
    $cx += $script:g.MeasureString($s, $font, [System.Drawing.PointF]::Empty, $fmt).Width + $tracking
  }
  return $cx
}

# El punto medio se arma por código: PowerShell 5.1 lee este archivo como ANSI y
# un "·" escrito literal sale como "Â·" en el render.
$mid = [char]0x00B7

$tx = 650
$fTitle = New-Object System.Drawing.Font("Constantia", 60, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fTag   = New-Object System.Drawing.Font("Constantia", 21, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$fLeag  = New-Object System.Drawing.Font("Constantia", 19, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)

$titleGrad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.PointF($tx, 148)), (New-Object System.Drawing.PointF($tx, 228)),
  $goldLite, $goldDark)
$tb = New-Object System.Drawing.Drawing2D.ColorBlend 3
$tb.Colors = @($goldLite, $goldMid, $goldDark)
$tb.Positions = @(0.0, 0.55, 1.0)
$titleGrad.InterpolationColors = $tb

# Sombra grabada bajo el título, el mismo recurso que el bisel del trazo.
[void](Draw-Tracked "CHECKMATCH" $fTitle (New-Object System.Drawing.SolidBrush (C 0 0 0 150)) ($tx + 3) 153 9)
$endX = Draw-Tracked "CHECKMATCH" $fTitle $titleGrad $tx 150 9
[void](Draw-Tracked "LOL" $fTitle (New-Object System.Drawing.SolidBrush (C 0 0 0 150)) ($endX + 25) 153 9)
$endX2 = Draw-Tracked "LOL" $fTitle (New-Object System.Drawing.SolidBrush $accent) ($endX + 22) 150 9

# Regla con rombo, la separación estándar del cliente.
$ruleY = 246
$g.FillRectangle((New-Object System.Drawing.SolidBrush $goldDark), $tx, $ruleY, ($endX2 - $tx), 3)
$dpts = @(
  (New-Object System.Drawing.PointF(($tx + 2), ($ruleY + 1.5))),
  (New-Object System.Drawing.PointF(($tx + 13), ($ruleY - 9.5))),
  (New-Object System.Drawing.PointF(($tx + 24), ($ruleY + 1.5))),
  (New-Object System.Drawing.PointF(($tx + 13), ($ruleY + 12.5)))
)
$g.FillPolygon($brushGold, $dpts)

[void](Draw-Tracked "LECTURA ESTRUCTURADA Y FALSABLE DE DRAFTS" $fTag `
  (New-Object System.Drawing.SolidBrush $cream) $tx 274 4.5)
$leagues = "LCK  $mid  LCK CL  $mid  LPL  $mid  LEC  $mid  LCS  $mid  CBLOL"
[void](Draw-Tracked $leagues $fLeag (New-Object System.Drawing.SolidBrush $goldDark) $tx 318 4)

# --- grano ------------------------------------------------------------------
for ($i = 0; $i -lt 9000; $i++) {
  $x = $rand.Next(0, $W); $y = $rand.Next(0, $H); $a = $rand.Next(5, 16)
  $c = if ($rand.NextDouble() -gt 0.5) { C 0 0 0 $a } else { C 190 205 235 $a }
  $b = New-Object System.Drawing.SolidBrush $c
  $g.FillRectangle($b, $x, $y, $rand.Next(1, 3), $rand.Next(1, 3))
  $b.Dispose()
}

$g.Dispose()

$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
  Where-Object { $_.MimeType -eq 'image/jpeg' }
$params = New-Object System.Drawing.Imaging.EncoderParameters 1
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
  [System.Drawing.Imaging.Encoder]::Quality, [long]94)

$file = Join-Path $outDir "checkmatch-banner-1500x500.jpg"
$bmp.Save($file, $codec, $params)
Write-Host "escrito: $file"
$bmp.Dispose()
