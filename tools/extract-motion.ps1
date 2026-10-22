# Dumps the motion samples (accelerometer + gyro) of RED clips to CSV, for checking REDFlipper's
# gyro calibration. Reads only each chunk's index and its motion blocks (a few MB per clip).
# Usage: powershell -ExecutionPolicy Bypass -File extract-motion.ps1 -OutDir <folder> <clip.RDC folder> [...]
param([string]$OutDir, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Clips)

function U32([byte[]]$b, [int]$o) { return ([uint32]$b[$o] -shl 24) -bor ([uint32]$b[$o + 1] -shl 16) -bor ([uint32]$b[$o + 2] -shl 8) -bor [uint32]$b[$o + 3] }
function I16([byte[]]$b, [int]$o) { $v = ([int]$b[$o] -shl 8) -bor [int]$b[$o + 1]; if ($v -ge 32768) { $v -= 65536 }; return $v }
function ReadAt($fs, [long]$pos, [int]$len) {
  $buf = New-Object byte[] $len
  [void]$fs.Seek($pos, [System.IO.SeekOrigin]::Begin)
  $got = 0
  while ($got -lt $len) { $n = $fs.Read($buf, $got, $len - $got); if ($n -le 0) { break }; $got += $n }
  return ,$buf
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
foreach ($clip in $Clips) {
  $name = [System.IO.Path]::GetFileNameWithoutExtension($clip.TrimEnd('\', '/'))
  $out = Join-Path $OutDir "$name.csv"
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.AppendLine("t_us,ax,ay,az,gx,gy,gz")
  $chunks = Get-ChildItem -Path $clip -Filter *.R3D | Sort-Object Name
  $samples = 0
  foreach ($ch in $chunks) {
    $fs = [System.IO.File]::OpenRead($ch.FullName)
    try {
      $size = $fs.Length
      $tailStart = [Math]::Max([long]0, [long]($size - 65536))
      $tail = ReadAt $fs $tailStart ([int]($size - $tailStart))
      $first = (4096 - ($tailStart % 4096)) % 4096
      $rix = -1; $rixSize = 0
      for ($off = $first; $off + 8 -le $tail.Length; $off += 4096) {
        $bs = U32 $tail $off
        $kind = [System.Text.Encoding]::ASCII.GetString($tail, $off + 4, 3) + [char]$tail[$off + 7]
        if ($bs -ge 68 -and $off + $bs -le $tail.Length -and $kind -eq ("RIX" + [char]2)) { $rix = $off; $rixSize = $bs }
      }
      if ($rix -lt 0) { Write-Host "$($ch.Name): no index, skipped"; continue }
      for ($o = $rix + 68; $o + 8 -le $rix + $rixSize; $o += 8) {
        $pos = [long](U32 $tail $o) * 4096; $bsize = [int](U32 $tail ($o + 4))
        if ($bsize -le 4096) { continue }
        $b = ReadAt $fs $pos $bsize
        if ([System.Text.Encoding]::ASCII.GetString($b, 4, 3) -ne "RDX" -or $b[7] -ne 2) { continue }
        for ($s = 4096; $s + 20 -le $bsize; $s += 20) {
          $t = [uint64](U32 $b $s) * 4294967296 + [uint64](U32 $b ($s + 4))
          [void]$sb.Append($t).Append(',').Append((I16 $b ($s + 8))).Append(',').Append((I16 $b ($s + 10))).Append(',').Append((I16 $b ($s + 12)))
          [void]$sb.Append(',').Append((I16 $b ($s + 14))).Append(',').Append((I16 $b ($s + 16))).Append(',').AppendLine((I16 $b ($s + 18)))
          $samples++
        }
      }
    } finally { $fs.Close() }
  }
  [System.IO.File]::WriteAllText($out, $sb.ToString())
  Write-Host "$name : $samples samples -> $out"
}
