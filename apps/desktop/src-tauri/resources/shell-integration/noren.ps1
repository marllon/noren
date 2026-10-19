# Noren shell integration for PowerShell 5.1 and 7+.
#
# Noren starts the shell with this file loaded AFTER the user's profile, so the profile and the
# user's prompt keep working: the prompt function that exists at this point is wrapped, not
# replaced. The script only writes escape sequences to the terminal; it changes no setting and
# runs nothing the user did not type.
#
#   OSC 7    ; file://host/path       the current folder (every prompt)
#   OSC 133  ; A / B                  the prompt starts / ends
#   OSC 133  ; C                      the command starts running
#   OSC 133  ; D ; code               the command ended, with its exit code
#   OSC 633  ; E ; command line       the command line (backslash, ';' and control characters
#                                     are written as \\ and \xNN)
#
# Keep this file ASCII only: Windows PowerShell 5.1 reads a file without a byte order mark in the
# ANSI code page.

if ($Global:__NorenIntegration) { return }
if (-not [Environment]::UserInteractive) { return }

$Global:__NorenIntegration = @{
    Running  = $false
    Original = $Function:prompt
    ReadLine = $Function:PSConsoleHostReadLine
}

# Longest command line sent in OSC 633;E. The terminal side drops a sequence over 8 KiB.
$Global:__NorenMaxLine = 2000

function Global:__NorenEscapeLine([string]$Line) {
    Set-StrictMode -Off
    if ($Line.Length -gt $Global:__NorenMaxLine) { $Line = $Line.Substring(0, $Global:__NorenMaxLine) }
    $builder = New-Object System.Text.StringBuilder
    foreach ($ch in $Line.ToCharArray()) {
        $code = [int]$ch
        if ($code -eq 92) { [void]$builder.Append('\\') }
        elseif ($code -lt 32 -or $code -eq 127 -or $code -eq 59) { [void]$builder.Append(('\x{0:x2}' -f $code)) }
        else { [void]$builder.Append($ch) }
    }
    return $builder.ToString()
}

# "file://host/C:/Users/me" for the current folder; $null when it is not a file system folder.
function Global:__NorenCwdUri {
    Set-StrictMode -Off
    try {
        $location = $executionContext.SessionState.Path.CurrentLocation
        if ($location.Provider.Name -ne 'FileSystem') { return $null }
        $path = $location.ProviderPath.Replace('\', '/')
        $hostName = [Environment]::MachineName
        if ($path.StartsWith('//')) {
            # \\server\share\dir
            $rest = $path.Substring(2)
            $slash = $rest.IndexOf('/')
            if ($slash -lt 0) { return $null }
            $hostName = $rest.Substring(0, $slash)
            $path = $rest.Substring($slash)
        }
        elseif ($path -match '^[A-Za-z]:') {
            $path = '/' + $path
        }
        $parts = New-Object System.Collections.Generic.List[string]
        foreach ($segment in $path.Split('/')) { $parts.Add([Uri]::EscapeDataString($segment)) }
        $encoded = [string]::Join('/', $parts) -replace '^/([A-Za-z])%3A', '/$1:'
        return "file://$hostName$encoded"
    }
    catch {
        return $null
    }
}

function Global:prompt {
    # Read first: these describe the command that just ran.
    $lastOk = $?
    $lastCode = $global:LASTEXITCODE
    Set-StrictMode -Off
    $esc = [char]27
    $bel = [char]7
    $state = $Global:__NorenIntegration
    $out = ''

    if ($state.Running) {
        $state.Running = $false
        if ($lastOk) { $code = 0 }
        elseif (($lastCode -is [int]) -and $lastCode -ne 0) { $code = $lastCode }
        else { $code = 1 }
        $out += "$esc]133;D;$code$bel"
    }

    $uri = __NorenCwdUri
    if ($null -ne $uri) { $out += "$esc]7;$uri$bel" }
    $out += "$esc]133;A$bel"

    # Give the user's prompt the same $? it would have had without this wrapper.
    if (-not $lastOk) { Write-Error 'noren' -ErrorAction Ignore }
    if ($null -ne $state.Original) {
        $text = "$(& $state.Original)"
    }
    else {
        $text = 'PS ' + $executionContext.SessionState.Path.CurrentLocation + ('>' * ($nestedPromptLevel + 1)) + ' '
    }
    return $out + $text + "$esc]133;B$bel"
}

# PSReadLine calls this function to read each command. The line is known only when it returns,
# which is the moment the command is about to run.
if ($null -ne $Global:__NorenIntegration.ReadLine) {
    function Global:PSConsoleHostReadLine {
        $line = & $Global:__NorenIntegration.ReadLine
        if (-not [string]::IsNullOrWhiteSpace($line)) {
            $esc = [char]27
            $bel = [char]7
            $Global:__NorenIntegration.Running = $true
            [Console]::Write("$esc]633;E;$(__NorenEscapeLine $line)$bel$esc]133;C$bel")
        }
        return $line
    }
}
