$p = 'N:\vs code apps\forge-relay\.coordination\events.ndjson'
$pos = 0
if (Test-Path $p) { $pos = (Get-Item $p).Length }
while ($true) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $p) {
        $len = (Get-Item $p).Length
        if ($len -gt $pos) {
            $fs = [System.IO.File]::Open($p, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
            $fs.Seek($pos, 0) | Out-Null
            $sr = New-Object System.IO.StreamReader($fs)
            while (-not $sr.EndOfStream) {
                $l = $sr.ReadLine()
                if ($l.Trim()) { Write-Output $l }
            }
            $sr.Close()
            $fs.Close()
            $pos = $len
        }
    }
}
