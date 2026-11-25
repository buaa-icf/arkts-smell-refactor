$script:RollbackIgnoredDirectories = @('.git', '.hvigor', '.homegraph', '.cache', '.test', 'build', 'coverage', 'oh_modules', 'node_modules')
$script:RollbackSourceExtensions = @('.ets', '.ts')

function Get-RollbackHash([string]$Path) {
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($Path)
    try { return [System.BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
    finally { $stream.Dispose() }
  } finally { $algorithm.Dispose() }
}

function Get-RollbackSourceFiles([string]$SourceRoot) {
  $directories = [System.Collections.Generic.Stack[string]]::new()
  $directories.Push($SourceRoot)
  while ($directories.Count -gt 0) {
    foreach ($item in Get-ChildItem -LiteralPath $directories.Pop() -Force -ErrorAction Stop) {
      if ($script:RollbackIgnoredDirectories -contains $item.Name) { continue }
      # Windows PowerShell 5.1 follows directory junctions during recursive enumeration.
      if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "Rollback cannot verify a linked path: $($item.FullName)"
      }
      if ($item.PSIsContainer) {
        $directories.Push($item.FullName)
      } else {
        $relative = Get-RollbackRelativePath $SourceRoot $item.FullName
        if ($script:RollbackSourceExtensions -contains $item.Extension -or $relative -match '(^|[\\/])src[\\/]main[\\/]resources[\\/]') {
          $item
        }
      }
    }
  }
}

function Get-RollbackRelativePath([string]$SourceRoot, [string]$Path) {
  $root = [System.IO.Path]::GetFullPath($SourceRoot).TrimEnd('\')
  $full = [System.IO.Path]::GetFullPath($Path)
  $prefix = $root + '\'
  if (-not $full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Rollback path is outside the source root: $full"
  }
  return $full.Substring($prefix.Length)
}

function Get-RollbackTargetPath([string]$SourceRoot, [string]$RelativePath) {
  $root = [System.IO.Path]::GetFullPath($SourceRoot).TrimEnd('\')
  $target = [System.IO.Path]::GetFullPath((Join-Path $root $RelativePath))
  if (-not $target.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Rollback target is outside the source root: $RelativePath"
  }
  Assert-RollbackPathWithoutLinks $target $root
  return $target
}

function Assert-RollbackPathWithoutLinks([string]$Path, [string]$StopAt = '') {
  $current = [System.IO.Path]::GetFullPath($Path)
  while ($current) {
    try {
      $attributes = [System.IO.File]::GetAttributes($current)
      if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "Rollback cannot verify a linked path: $current"
      }
    } catch [System.IO.FileNotFoundException] {
      # A deleted file can be restored after checking its existing ancestors.
    } catch [System.IO.DirectoryNotFoundException] {
      # Its parent directories may also need to be recreated.
    }
    if ($current -eq $StopAt) { break }
    $current = [System.IO.Path]::GetDirectoryName($current)
  }
}

function New-TaskSourceSnapshot([string]$SourceRoot, [string]$SnapshotDirectory) {
  $root = [System.IO.Path]::GetFullPath($SourceRoot).TrimEnd('\')
  $snapshot = [System.IO.Path]::GetFullPath($SnapshotDirectory)
  Assert-RollbackPathWithoutLinks $root
  Assert-RollbackPathWithoutLinks $snapshot
  if ($snapshot.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Rollback snapshot must be outside the source root: $snapshot"
  }
  if (Test-Path -LiteralPath $snapshot) {
    throw "Rollback snapshot directory already exists: $snapshot"
  }
  $filesDirectory = Join-Path $snapshot 'files'
  New-Item -ItemType Directory -Path $filesDirectory -Force | Out-Null
  $entries = [System.Collections.Generic.List[object]]::new()
  foreach ($file in Get-RollbackSourceFiles $root) {
    $relative = Get-RollbackRelativePath $root $file.FullName
    $backup = Get-RollbackTargetPath $filesDirectory $relative
    New-Item -ItemType Directory -Path (Split-Path -Path $backup -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $backup -Force
    $entries.Add([pscustomobject]@{
      path = $relative
      sha256 = Get-RollbackHash $backup
    })
  }
  $manifest = [pscustomobject]@{
    schemaVersion = '1.0'
    sourceRoot = $root
    capturedAt = (Get-Date).ToString('o')
    files = $entries.ToArray()
  }
  $manifestPath = Join-Path $snapshot 'manifest.json'
  [System.IO.File]::WriteAllText(
    $manifestPath,
    ($manifest | ConvertTo-Json -Depth 5),
    [System.Text.UTF8Encoding]::new($false)
  )
  Write-Output "SNAPSHOT_SOURCE_FILES=$($entries.Count) root=$root"
  return $snapshot
}

function Restore-TaskSourceSnapshot([string]$SourceRoot, [string]$SnapshotDirectory) {
  $root = [System.IO.Path]::GetFullPath($SourceRoot).TrimEnd('\')
  $snapshot = [System.IO.Path]::GetFullPath($SnapshotDirectory)
  Assert-RollbackPathWithoutLinks $root
  Assert-RollbackPathWithoutLinks $snapshot
  $manifestPath = Get-RollbackTargetPath $snapshot 'manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "Rollback snapshot manifest is missing: $manifestPath"
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
  if ($manifest.sourceRoot -ne $root) {
    throw "Rollback source root differs from its snapshot: expected $($manifest.sourceRoot), got $root"
  }
  $baseline = @{}
  foreach ($entry in @($manifest.files)) {
    $baseline[[string]$entry.path] = [string]$entry.sha256
  }
  $restored = [System.Collections.Generic.List[string]]::new()
  foreach ($relative in $baseline.Keys) {
    $source = Get-RollbackTargetPath $root $relative
    $backup = Get-RollbackTargetPath (Join-Path $snapshot 'files') $relative
    if (-not (Test-Path -LiteralPath $backup)) {
      throw "Rollback backup is missing: $relative"
    }
    $needsRestore = -not (Test-Path -LiteralPath $source)
    if (-not $needsRestore) {
      $needsRestore = (Get-RollbackHash $source) -ne $baseline[$relative]
    }
    if ($needsRestore) {
      if ((Get-RollbackHash $backup) -ne $baseline[$relative]) {
        throw "Rollback backup hash verification failed: $relative"
      }
      New-Item -ItemType Directory -Path (Split-Path -Path $source -Parent) -Force | Out-Null
      Copy-Item -LiteralPath $backup -Destination $source -Force
      $restoredHash = Get-RollbackHash $source
      if ($restoredHash -ne $baseline[$relative]) {
        throw "Rollback hash verification failed: $relative"
      }
      $restored.Add($relative)
    }
  }
  $removed = [System.Collections.Generic.List[string]]::new()
  foreach ($file in Get-RollbackSourceFiles $root) {
    $relative = Get-RollbackRelativePath $root $file.FullName
    if (-not $baseline.ContainsKey($relative)) {
      Remove-Item -LiteralPath $file.FullName -Force
      if (Test-Path -LiteralPath $file.FullName) {
        throw "Rollback removal verification failed: $relative"
      }
      $removed.Add($relative)
    }
  }
  foreach ($relative in $restored) { Write-Output "RESTORED=$relative" }
  foreach ($relative in $removed) { Write-Output "REMOVED_NEW=$relative" }
  Write-Output "ROLLBACK_SNAPSHOT=$snapshot restored=$($restored.Count) removedNew=$($removed.Count) baselineFiles=$($baseline.Count)"
}
