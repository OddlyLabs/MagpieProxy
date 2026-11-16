param(
  [ValidateSet('Install', 'Open', 'Doctor')][string]$Action = 'Install',
  [string]$MagpiePath = '',
  [string]$InstallDir = '',
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$sourceDir = $PSScriptRoot

function Quote-ProcessArgument([string]$Value) {
  # Windows CreateProcess quoting, including JSON, quotes and trailing slashes.
  $escaped = [regex]::Replace($Value, '(\\*)"', '${1}${1}\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '${1}${1}')
  return '"' + $escaped + '"'
}
function Invoke-Program([string]$Program, [string[]]$Arguments, [int]$TimeoutSeconds = 300) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $Program
  $info.Arguments = (($Arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join ' ')
  $info.UseShellExecute = $false; $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $info.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $info
  try {
    [void]$proc.Start()
    $stdout = $proc.StandardOutput.ReadToEndAsync(); $stderr = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
      try { $proc.Kill() } catch {}
      throw "Command timed out: $Program"
    }
    return @{ Code = $proc.ExitCode; Out = $stdout.Result; Err = $stderr.Result }
  } finally { $proc.Dispose() }
}
function Read-Json([string]$Path) {
  if (Test-Path -LiteralPath $Path -PathType Leaf) { return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json }
  return $null
}
function Write-Json([string]$Path, $Value) {
  [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 30), (New-Object System.Text.UTF8Encoding($false)))
}
function Find-Magpie {
  if ($MagpiePath) {
    if (-not (Test-Path -LiteralPath $MagpiePath -PathType Leaf)) { throw "找不到指定的 magpie：$MagpiePath" }
    return (Resolve-Path -LiteralPath $MagpiePath).Path
  }
  $candidates = @($env:MAGPIE_EXE)
  $metadata = Read-Json (Join-Path $sourceDir 'installation.json')
  if ($metadata) { $candidates += $metadata.magpieExe }
  $candidates += @(Get-Process -Name 'magpie*' -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Path } catch {} })
  $cmd = Get-Command magpie.exe -ErrorAction SilentlyContinue
  if ($cmd) { $candidates += $cmd.Source }
  foreach ($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\magpie.exe', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\magpie.exe')) {
    if (Test-Path $key) { $candidates += (Get-ItemProperty $key).'(default)' }
  }
  foreach ($base in @($sourceDir, (Split-Path $sourceDir), "$env:LOCALAPPDATA\Programs\Magpie", "$env:USERPROFILE\scoop\apps\magpie\current")) {
    $candidates += Join-Path $base 'magpie.exe'
  }
  foreach ($candidate in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  Add-Type -AssemblyName System.Windows.Forms
  $picker = New-Object System.Windows.Forms.OpenFileDialog
  $picker.Title = '请选择你正在使用的 magpie 程序'; $picker.Filter = 'magpie (*.exe)|*.exe'
  try { if ($picker.ShowDialog() -eq 'OK') { return $picker.FileName } }
  finally { $picker.Dispose() }
  throw '未选择 magpie。可重新运行 Install.cmd，或使用 -MagpiePath 指定程序路径。'
}
function Find-Runtime([string]$CacheDir) {
  $candidates = @($env:MAGPIE_BUN)
  foreach ($name in @('bun.exe', 'node.exe')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { $candidates += $cmd.Source }
  }
  if ($CacheDir -and (Test-Path -LiteralPath (Join-Path $CacheDir 'bun'))) {
    $candidates += @(Get-ChildItem -LiteralPath (Join-Path $CacheDir 'bun') -Filter '*.exe' -Recurse -File | Sort-Object LastWriteTime -Descending | Where-Object { $_.Name -in @('magpie-bun.exe', 'bun.exe') } | ForEach-Object { $_.FullName })
  }
  foreach ($candidate in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    try {
      $probe = Invoke-Program $candidate @('-e', 'if (!process.versions.bun && Number(process.versions.node.split(".")[0]) < 22) process.exit(1)') 10
      if ($probe.Code -eq 0) { return $candidate }
    } catch {}
  }
  return $null
}
function Invoke-Manager([string]$Directory, [string[]]$Arguments) {
  $result = Invoke-Program $script:runtime (@((Join-Path $Directory 'manage.mjs')) + $Arguments) 45
  if ($result.Code -ne 0) { throw ($result.Out + $result.Err).Trim() }
  return $result.Out | ConvertFrom-Json
}

try {
  $manifest = Read-Json (Join-Path $sourceDir 'package.json')
  if (-not $manifest -or $manifest.name -ne 'magpie-zcode-egress') { throw '请完整解压插件 ZIP，然后运行目录内的 Install.cmd。' }
  $exe = Find-Magpie
  $paths = Invoke-Program $exe @('data') 20
  if ($paths.Code -ne 0 -or $paths.Out -notmatch '(?m)^files:\s*(.+)$') { throw "无法读取 magpie 数据目录，请确认选择了正确的 magpie 程序。`n$($paths.Err)" }
  $magpieData = $Matches[1].Trim()
  if ($paths.Out -notmatch '(?m)^cache:\s*(.+)$') { throw 'magpie 未返回缓存目录，请升级 magpie 后重试。' }
  $cacheDir = $Matches[1].Trim()
  $env:ZCODE_EGRESS_MAGPIE_DIR = $magpieData
  $target = if ($InstallDir) { [IO.Path]::GetFullPath($InstallDir) } else { Join-Path $magpieData 'local-plugins\magpie-zcode-egress' }
  $script:runtime = Find-Runtime $cacheDir

  if ($Action -eq 'Install') {
    Write-Host "正在安装出口管家 v$($manifest.version)…"
    Write-Host "magpie：$exe"
    Write-Host "安装目录：$target"
    $old = Read-Json (Join-Path $target 'installation.json')
    $registry = Read-Json (Join-Path $magpieData 'plugins.json')
    $copies = @()
    foreach ($entry in $registry.plugins) {
      try { if ((Read-Json (Join-Path $entry.spec 'package.json')).name -eq $manifest.name) { $copies += $entry } } catch {}
    }
    if ($script:runtime -and (Test-Path -LiteralPath (Join-Path $target 'package.json'))) {
      $state = Invoke-Manager $sourceDir @('status', '--json')
      if ($state.running) { throw '后台仍有任务在执行，请等任务结束后再运行安装。' }
      [void](Invoke-Manager $sourceDir @('stop', '--json'))
    }
    $stage = $target + '.staging-' + [guid]::NewGuid().ToString('N')
    $backup = $target + '.previous-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    $replaced = $false; $moved = $false
    try {
      if ([IO.Path]::GetFullPath($sourceDir).TrimEnd('\') -ne [IO.Path]::GetFullPath($target).TrimEnd('\')) {
        [void](New-Item -ItemType Directory -Path $stage -Force)
        foreach ($relative in (@('package.json') + @($manifest.files))) {
          $from = Join-Path $sourceDir $relative
          if (-not (Test-Path -Path $from)) { throw "安装包缺少文件：$relative" }
          $destination = Join-Path $stage $relative
          $parentDir = Split-Path $destination
          [void](New-Item -ItemType Directory -Path $parentDir -Force)
          if ($relative.Contains('*')) { Copy-Item -Path $from -Destination $parentDir -Force }
          else { Copy-Item -LiteralPath $from -Destination $destination -Recurse -Force }
        }
        if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination $backup; $moved = $true }
        Move-Item -LiteralPath $stage -Destination $target; $replaced = $true
      }
      Write-Json (Join-Path $target 'installation.json') @{ schema = 1; magpieExe = $exe; magpieDir = $magpieData; version = $manifest.version; installedAt = [DateTime]::UtcNow.ToString('o') }
      Write-Host '正在向 magpie 注册插件；首次安装可能需要 magpie 下载 Bun…'
      $registered = Invoke-Program $exe @('plugin', 'add', $target)
      $registry = Read-Json (Join-Path $magpieData 'plugins.json')
      $mine = @($registry.plugins | Where-Object { $_.spec -eq $target })
      if (-not $mine.Count) { throw "插件注册失败。`n$($registered.Out)`n$($registered.Err)" }
      $enabled = Invoke-Program $exe @('plugin', 'on', $target)
      if ($enabled.Code -ne 0) { throw "无法启用插件：$($enabled.Err)" }
      $script:runtime = Find-Runtime $cacheDir
      if (-not $script:runtime) { throw '未找到可用的 Bun 或 Node.js 22+。请在 magpie 中打开一次插件页，让 magpie 完成 Bun 下载，再重新运行 Install.cmd。' }
      $ready = Invoke-Manager $target @('open', '--no-browser', '--json')
      $options = @{}
      if ($mine[0].options) { foreach ($property in $mine[0].options.PSObject.Properties) { $options[$property.Name] = $property.Value } }
      $options['port'] = $ready.port; $options['request'] = $null
      $set = Invoke-Program $exe @('plugin', 'options', $target, ($options | ConvertTo-Json -Depth 20 -Compress))
      if ($set.Code -ne 0) { throw "无法保存页面端口：$($set.Err)" }
      foreach ($copy in $copies) {
        if ($copy.spec -ne $target -and -not $copy.off) {
          $disabled = Invoke-Program $exe @('plugin', 'off', $copy.spec)
          if ($disabled.Code -ne 0) { Write-Host "请在插件管理中停用旧副本：$($copy.spec)" }
        }
      }
      $doctor = Invoke-Manager $target @('doctor', '--json')
      if (-not $doctor.ok) { throw '安装检查未通过，请运行 Diagnose.cmd。' }
      Write-Host "安装成功。浏览器面板：$($ready.url)"
      Write-Host 'magpie 入口：导航栏底部「插件 → 出口管家」；设置中也有出口管家面板。'
      Write-Host '如果 magpie 已打开，请刷新窗口。安装过程不会修改 magpie 主程序。'
      if ($moved) { Write-Host "旧版文件备份：$backup" }
      if (-not $NoBrowser) { Start-Process $ready.url }
    } catch {
      if ($moved) {
        if (Test-Path -LiteralPath $target) {
          $failed = $target + '.failed-' + [guid]::NewGuid().ToString('N')
          Move-Item -LiteralPath $target -Destination $failed
          Write-Host "失败版本保留在：$failed"
        }
        Move-Item -LiteralPath $backup -Destination $target
        Write-Host "已恢复旧版文件：$target"
      }
      throw
    } finally { if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force } }
  } else {
    $directory = if (Test-Path -LiteralPath (Join-Path $target 'installation.json')) { $target } else { $sourceDir }
    if (-not $script:runtime) { throw '未找到 Bun 或 Node.js 22+，请先运行 Install.cmd。' }
    $arguments = @((Join-Path $directory 'manage.mjs'), $(if ($Action -eq 'Open') { 'open' } else { 'doctor' }))
    if ($NoBrowser) { $arguments += '--no-browser' }
    $result = Invoke-Program $script:runtime $arguments 45
    Write-Host $result.Out
    if ($result.Err) { Write-Host $result.Err }
    if ($Action -eq 'Doctor') {
      $reportPath = Join-Path $directory 'diagnostics.txt'
      [IO.File]::WriteAllText($reportPath, $result.Out + $result.Err, (New-Object System.Text.UTF8Encoding($false)))
      Write-Host "诊断结果已保存：$reportPath"
    }
    if ($result.Code -ne 0) { exit $result.Code }
  }
} catch {
  Write-Host "未完成：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
