Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Write-Host "VS Code activity script started. Press Ctrl+C to stop." -ForegroundColor Green

# Programming keywords to type
$keywords = @(
    "const", "let", "function", "return", "async", "await",
    "import", "export", "class", "constructor", "if", "else",
    "for", "while", "map", "filter", "reduce", "find",
    "Object", "Array", "string", "number", "boolean", "Promise", "console.log"
)

while ($true) {
    # Move mouse randomly by 10-30 pixels
    $currentPos = [System.Windows.Forms.Cursor]::Position
    $randomX = Get-Random -Minimum -30 -Maximum 31
    $randomY = Get-Random -Minimum -30 -Maximum 31

    $newX = $currentPos.X + $randomX
    $newY = $currentPos.Y + $randomY
    [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($newX, $newY)

    # Pick a random programming keyword
    $keyword = $keywords | Get-Random

    # Type it into the currently focused editor
    [System.Windows.Forms.SendKeys]::SendWait($keyword)
    [System.Windows.Forms.SendKeys]::SendWait(" ")

    # Wait 10-30 seconds
    $sleepTime = Get-Random -Minimum 10 -Maximum 31
    Write-Host "Typed: $keyword | Next action in $sleepTime seconds"
    Start-Sleep -Seconds $sleepTime
}