param(
    [string]$Query = "",
    [ValidateSet("audio", "movies", "software", "texts", "image", "collection", "web", "data")]
    [string]$MediaType = "audio",
    [string]$WaybackUrl = "",
    [int]$Rows = 25,
    [string]$Output = "data/archive-commons/latest-results.json"
)

$ErrorActionPreference = "Stop"

if ($Rows -lt 1 -or $Rows -gt 100) {
    throw "Rows must be between 1 and 100 for safe metadata batching."
}

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$outputPath = Join-Path $root $Output
$outputDir = Split-Path -Parent $outputPath
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

function Get-RightsDecision {
    param(
        [string]$LicenseUrl,
        [string]$Rights,
        [string]$Title = "",
        [string]$Collection = "",
        [string]$Source = "internet_archive"
    )

    $combined = @($LicenseUrl, $Rights, $Title, $Collection) -join " "
    $openSignal = $combined -match "creativecommons|creative commons|public domain|publicdomain|cc0|gpl|mit license|apache license|bsd license|open source"
    $restrictedSignal = $combined -match "controlled digital lending|borrow|commercial|all rights reserved"

    if ($Source -eq "wayback") {
        return [pscustomobject]@{
            rightsState = "needs_rights_review"
            downloadAllowed = $false
            downloadDecision = "allow_metadata_only"
            reviewAction = "Use as citation metadata only; Wayback capture does not grant republishing rights."
        }
    }

    if ($restrictedSignal -and -not $openSignal) {
        return [pscustomobject]@{
            rightsState = "held"
            downloadAllowed = $false
            downloadDecision = "reject_likely_restricted"
            reviewAction = "Do not download; rights signal suggests restriction or controlled access."
        }
    }

    if ($openSignal) {
        return [pscustomobject]@{
            rightsState = "candidate_open_rights"
            downloadAllowed = $false
            downloadDecision = "candidate_download_after_operator_review"
            reviewAction = "Operator must verify license, expected size, storage target, and rollback plan before download."
        }
    }

    return [pscustomobject]@{
        rightsState = "needs_rights_review"
        downloadAllowed = $false
        downloadDecision = "hold_no_rights_signal"
        reviewAction = "Keep metadata only until license or redistribution rights are verified."
    }
}

function Invoke-ArchiveSearch {
    param(
        [string]$SearchQuery,
        [string]$Type,
        [int]$Limit
    )

    $baseQuery = if ([string]::IsNullOrWhiteSpace($SearchQuery)) {
        "mediatype:$Type"
    } else {
        "($SearchQuery) AND mediatype:$Type"
    }

    $uri = "https://archive.org/advancedsearch.php"
    $fields = @("identifier", "title", "creator", "date", "mediatype", "collection", "licenseurl", "rights", "publicdate")
    $queryParams = @{
        q = $baseQuery
        rows = $Limit
        page = 1
        output = "json"
    }

    $fieldPairs = foreach ($field in $fields) { "fl[]=$([uri]::EscapeDataString($field))" }
    $queryString = ($queryParams.GetEnumerator() | ForEach-Object {
        "$([uri]::EscapeDataString($_.Key))=$([uri]::EscapeDataString([string]$_.Value))"
    }) -join "&"
    $fullUri = "$uri`?$queryString&$($fieldPairs -join '&')"
    $response = Invoke-RestMethod -Uri $fullUri -Method Get

    foreach ($doc in $response.response.docs) {
        $rightsDecision = Get-RightsDecision -LicenseUrl $doc.licenseurl -Rights $doc.rights -Title $doc.title -Collection (($doc.collection -join " "))
        [pscustomobject]@{
            state = "metadata_only"
            source = "internet_archive_advancedsearch"
            identifier = $doc.identifier
            title = $doc.title
            creator = $doc.creator
            date = $doc.date
            mediatype = $doc.mediatype
            collection = $doc.collection
            licenseurl = $doc.licenseurl
            rights = $doc.rights
            publicdate = $doc.publicdate
            itemUrl = "https://archive.org/details/$($doc.identifier)"
            metadataUrl = "https://archive.org/metadata/$($doc.identifier)"
            rightsState = $rightsDecision.rightsState
            downloadAllowed = $rightsDecision.downloadAllowed
            downloadDecision = $rightsDecision.downloadDecision
            reviewAction = $rightsDecision.reviewAction
        }
    }
}

function Invoke-WaybackCdx {
    param(
        [string]$Url,
        [int]$Limit
    )

    $uri = "https://web.archive.org/cdx/search/cdx"
    $query = @{
        url = $Url
        output = "json"
        fl = "timestamp,original,mimetype,statuscode,digest,length"
        collapse = "digest"
        limit = $Limit
    }

    $queryString = ($query.GetEnumerator() | ForEach-Object {
        "$([uri]::EscapeDataString($_.Key))=$([uri]::EscapeDataString([string]$_.Value))"
    }) -join "&"

    $rows = Invoke-RestMethod -Uri "$uri`?$queryString" -Method Get
    if ($rows.Count -le 1) { return @() }

    foreach ($row in $rows[1..($rows.Count - 1)]) {
        $rightsDecision = Get-RightsDecision -Source "wayback"
        [pscustomobject]@{
            state = "metadata_only"
            source = "wayback_cdx"
            timestamp = $row[0]
            original = $row[1]
            mimetype = $row[2]
            statuscode = $row[3]
            digest = $row[4]
            length = $row[5]
            replayUrl = "https://web.archive.org/web/$($row[0])/$($row[1])"
            rightsState = $rightsDecision.rightsState
            downloadAllowed = $rightsDecision.downloadAllowed
            downloadDecision = $rightsDecision.downloadDecision
            reviewAction = $rightsDecision.reviewAction
        }
    }
}

$result = [ordered]@{
    generatedAt = (Get-Date).ToString("o")
    mode = if ([string]::IsNullOrWhiteSpace($WaybackUrl)) { "archive_advancedsearch" } else { "wayback_cdx" }
    rowsRequested = $Rows
    policy = "metadata-first; rights-gated; no bulk media downloads"
    items = @()
}

if (-not [string]::IsNullOrWhiteSpace($WaybackUrl)) {
    $result.items = @(Invoke-WaybackCdx -Url $WaybackUrl -Limit $Rows)
} else {
    $result.items = @(Invoke-ArchiveSearch -SearchQuery $Query -Type $MediaType -Limit $Rows)
}

$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $outputPath -Encoding UTF8
Write-Output $outputPath
