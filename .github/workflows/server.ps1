param([int]$Port = 3000)

# ── Load .env ────────────────────────────────────────────────────────────────
$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([^#][^=]*?)\s*=\s*(.*?)\s*$') {
            [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
        }
    }
}

$JIRA_EMAIL = $env:JIRA_EMAIL
$JIRA_TOKEN = $env:JIRA_TOKEN
$JIRA_BASE  = "https://mews.atlassian.net"

if (-not $JIRA_EMAIL -or -not $JIRA_TOKEN) {
    Write-Host ""
    Write-Host "  Missing credentials. Create a .env file:" -ForegroundColor Red
    Write-Host "    JIRA_EMAIL=you@mews.com" -ForegroundColor Yellow
    Write-Host "    JIRA_TOKEN=your-api-token" -ForegroundColor Yellow
    Write-Host "  (see .env.example)" -ForegroundColor DarkGray
    Write-Host ""
    exit 1
}

$authB64  = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes("${JIRA_EMAIL}:${JIRA_TOKEN}"))
$headers  = @{ Authorization = "Basic $authB64"; Accept = "application/json" }

$PLAYERS = @(
    @{ project = "POTW";  name = "William"; color = "#38bdf8"; jiraUrl = "$JIRA_BASE/jira/core/projects/POTW" }
    @{ project = "TRAIN"; name = "Eduardo"; color = "#4ade80"; jiraUrl = "$JIRA_BASE/jira/core/projects/TRAIN/board" }
    @{ project = "POTE";  name = "Eloisa";  color = "#f472b6"; jiraUrl = "$JIRA_BASE/jira/core/projects/POTE/board" }
)

# ── Jira fetch ────────────────────────────────────────────────────────────────
function Get-TrainingData {
    $jql     = "project IN (POTW, TRAIN, POTE) ORDER BY project ASC, created ASC"
    $fields  = "summary,status"
    $url     = "$JIRA_BASE/rest/api/3/search?jql=$([Uri]::EscapeDataString($jql))&fields=$fields&maxResults=200"

    try {
        $resp = Invoke-RestMethod -Uri $url -Headers $headers -Method Get -ErrorAction Stop
    } catch {
        Write-Warning "Jira API error: $($_.Exception.Message)"
        return $null
    }

    # Bucket issues by project
    $byProject = @{}
    foreach ($p in $PLAYERS) { $byProject[$p.project] = [System.Collections.ArrayList]@() }

    foreach ($issue in $resp.issues) {
        $projKey = $issue.key -replace '-[0-9]+$', ''
        if (-not $byProject.ContainsKey($projKey)) { continue }

        $summary   = $issue.fields.summary
        $weekMatch = [regex]::Match($summary, '^\[([W0-9/]+)\]\s*')
        $weekTag   = if ($weekMatch.Success) { $weekMatch.Groups[1].Value } else { "Other" }
        $cleanSumm = $summary -replace '^\[[W0-9/]+\]\s*', ''

        $catKey = $issue.fields.status.statusCategory.key
        $bucket = switch ($catKey) {
            "done"          { "done" }
            "indeterminate" { "inprogress" }
            default         { "todo" }
        }

        [void]$byProject[$projKey].Add([PSCustomObject]@{
            key     = $issue.key
            summary = $cleanSumm
            week    = $weekTag
            status  = $bucket
            url     = "$JIRA_BASE/browse/$($issue.key)"
        })
    }

    # Build per-player objects
    $players = foreach ($p in $PLAYERS) {
        $tasks = @($byProject[$p.project])
        [PSCustomObject]@{
            name       = $p.name
            project    = $p.project
            color      = $p.color
            jiraUrl    = $p.jiraUrl
            tasks      = $tasks
            stats      = [PSCustomObject]@{
                done       = @($tasks | Where-Object status -eq "done").Count
                inProgress = @($tasks | Where-Object status -eq "inprogress").Count
                todo       = @($tasks | Where-Object status -eq "todo").Count
                total      = $tasks.Count
            }
        }
    }

    # ── Program-level aggregate stats ─────────────────────────────────────────
    $allTasks     = @($players | ForEach-Object { $_.tasks })
    $programStart = [datetime]::Parse("2026-05-22")
    $today        = (Get-Date).Date
    $daysIn       = [int]($today - $programStart).TotalDays
    $currentWeek  = [math]::Min([math]::Max([math]::Ceiling(($daysIn + 1) / 7), 1), 5)

    # Per-week totals across all players
    $weekTags = @('W1','W1/W2','W2','W3','W4','W5','Other')
    $weeklyStats = [ordered]@{}
    foreach ($w in $weekTags) {
        $wTasks = @($allTasks | Where-Object { $_.week -eq $w })
        if ($wTasks.Count -gt 0) {
            $weeklyStats[$w] = [PSCustomObject]@{
                total      = $wTasks.Count
                done       = @($wTasks | Where-Object status -eq "done").Count
                inProgress = @($wTasks | Where-Object status -eq "inprogress").Count
            }
        }
    }

    $program = [PSCustomObject]@{
        startDate    = $programStart.ToString("yyyy-MM-dd")
        currentWeek  = $currentWeek
        daysIn       = $daysIn
        totalTasks   = $allTasks.Count
        totalDone    = @($allTasks | Where-Object status -eq "done").Count
        totalInProg  = @($allTasks | Where-Object status -eq "inprogress").Count
        totalTodo    = @($allTasks | Where-Object status -eq "todo").Count
        weeklyStats  = $weeklyStats
    }

    return [PSCustomObject]@{
        program     = $program
        players     = @($players)
        lastUpdated = (Get-Date).ToUniversalTime().ToString("o")
    }
}

# ── HTTP Server ───────────────────────────────────────────────────────────────
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()

$htmlFile = Join-Path $PSScriptRoot "training-dashboard.html"

Write-Host ""
Write-Host "  Training Dashboard  >>  http://localhost:$Port" -ForegroundColor Cyan
Write-Host "  Auto-refreshes every 60 s in the browser" -ForegroundColor DarkGray
Write-Host "  Press Ctrl+C to stop" -ForegroundColor DarkGray
Write-Host ""

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        $req = $ctx.Request
        $res = $ctx.Response

        $path = $req.Url.AbsolutePath
        Write-Host "  $($req.HttpMethod) $path" -ForegroundColor DarkGray

        try {
            if ($path -eq "/api/data") {
                $res.Headers.Add("Access-Control-Allow-Origin", "*")
                $res.ContentType = "application/json; charset=utf-8"

                $data = Get-TrainingData
                $json = if ($data) {
                    $data | ConvertTo-Json -Depth 10 -Compress
                } else {
                    '{"error":"Failed to fetch data from Jira"}'
                }
                $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
            } else {
                $res.ContentType = "text/html; charset=utf-8"
                $bytes = [System.IO.File]::ReadAllBytes($htmlFile)
            }

            $res.ContentLength64 = $bytes.Length
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
        } catch {
            Write-Warning "Request error: $_"
        } finally {
            try { $res.OutputStream.Close() } catch {}
        }
    }
} catch [System.Threading.ThreadAbortException] {
    # graceful stop
} finally {
    $listener.Stop()
    Write-Host "`n  Server stopped." -ForegroundColor DarkGray
}
