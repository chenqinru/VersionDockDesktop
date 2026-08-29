param(
  [Parameter(Mandatory = $true)]
  [string]$CacheRoot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Apache Subversion trunk r1935602 is the first upstream revision that converts
# Windows UTF-16 argv directly to UTF-8. No released 1.14.x/1.15.x Windows CLI
# contains this fix yet, so CI builds and caches this exact source revision.
$subversionCommit = "85707b2acbe4dac50d1c5e0ee72022c1ea5363ad"
$subversionArchiveSha512 = "5599f34f4332f763d5d6df1b405c858aeb053eba933e65571a9539e7ae81bbafe74bc95d825054444c5a8fb69b7f14c2852587b3d93ee10394db634aa9df17b8"
$vcpkgCommit = "e99d87dcf02926bfd629560e11e156329d5720c1"
$vcpkgArchiveSha512 = "1ce08c1008a4427c64bd541ced2bf2293ee78720e6a2b6550331ae194a26d4b34a8d0b1ad88efebc66ff5a7233d07ae3d7013f19ff85fe2dad39dbed4d55b2af"

function Assert-NativeSuccess([string]$Command) {
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code $LASTEXITCODE"
  }
}

function Get-VerifiedArchive(
  [string]$Uri,
  [string]$Destination,
  [string]$ExpectedSha512
) {
  Invoke-WebRequest -Uri $Uri -OutFile $Destination
  $actualSha512 = (Get-FileHash -LiteralPath $Destination -Algorithm SHA512).Hash.ToLowerInvariant()
  if ($actualSha512 -ne $ExpectedSha512) {
    throw "SHA-512 mismatch for $Uri. Expected $ExpectedSha512, got $actualSha512"
  }
}

function Test-NativeExecutable([string]$Executable) {
  try {
    & $Executable --version --quiet *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

$cacheRootPath = [System.IO.Path]::GetFullPath($CacheRoot)
$runtimeRoot = Join-Path $cacheRootPath "runtime"
$svnExecutable = Join-Path $runtimeRoot "bin\svn.exe"
$svnAdminExecutable = Join-Path $runtimeRoot "bin\svnadmin.exe"

if ((Test-Path -LiteralPath $svnExecutable) -and (Test-Path -LiteralPath $svnAdminExecutable)) {
  $svnWorks = Test-NativeExecutable $svnExecutable
  $svnAdminWorks = Test-NativeExecutable $svnAdminExecutable
  if ($svnWorks -and $svnAdminWorks) {
    Write-Host "Using cached Unicode-capable SVN runtime at $runtimeRoot"
    exit 0
  }
  Write-Warning "Discarding an incomplete Windows SVN runtime cache"
  Remove-Item -LiteralPath $runtimeRoot -Recurse -Force
}

$buildRoot = Join-Path $env:RUNNER_TEMP ("versiondock-svn-build-{0}" -f [guid]::NewGuid().ToString("N"))
$sourceArchive = Join-Path $buildRoot "subversion.zip"
$vcpkgArchive = Join-Path $buildRoot "vcpkg.zip"
$sourceParent = Join-Path $buildRoot "source"
$vcpkgParent = Join-Path $buildRoot "vcpkg-source"
$buildDirectory = Join-Path $buildRoot "out"
$installStaging = Join-Path $buildRoot "install"
$binaryCache = Join-Path $cacheRootPath "vcpkg-archives"

New-Item -ItemType Directory -Path $buildRoot, $sourceParent, $vcpkgParent, $binaryCache -Force | Out-Null

Get-VerifiedArchive `
  -Uri "https://github.com/apache/subversion/archive/$subversionCommit.zip" `
  -Destination $sourceArchive `
  -ExpectedSha512 $subversionArchiveSha512
Expand-Archive -LiteralPath $sourceArchive -DestinationPath $sourceParent
$sourceDirectory = (Get-ChildItem -LiteralPath $sourceParent -Directory | Select-Object -First 1).FullName

Get-VerifiedArchive `
  -Uri "https://github.com/microsoft/vcpkg/archive/$vcpkgCommit.zip" `
  -Destination $vcpkgArchive `
  -ExpectedSha512 $vcpkgArchiveSha512
Expand-Archive -LiteralPath $vcpkgArchive -DestinationPath $vcpkgParent
$vcpkgRoot = (Get-ChildItem -LiteralPath $vcpkgParent -Directory | Select-Object -First 1).FullName

$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$visualStudioRoot = & $vswhere -property installationPath -latest
Import-Module (Join-Path $visualStudioRoot "Common7\Tools\Microsoft.VisualStudio.DevShell.dll")
Enter-VsDevShell -VsInstallPath $visualStudioRoot -SkipAutomaticLocation -DevCmdArguments "-arch=x64"
$env:VCPKG_ROOT = $vcpkgRoot

& (Join-Path $vcpkgRoot "bootstrap-vcpkg.bat") -disableMetrics
Assert-NativeSuccess "vcpkg bootstrap"
$env:VCPKG_DEFAULT_BINARY_CACHE = $binaryCache
# VersionDock's integration suite uses local file:// repositories. HTTP/WebDAV
# support would pull in serf, OpenSSL and SCons even though none of them are
# exercised here, so keep the CI-only client limited to the protocols we test.
& (Join-Path $vcpkgRoot "vcpkg.exe") install --triplet x64-windows apr apr-util expat zlib sqlite3
Assert-NativeSuccess "vcpkg dependency installation"

Push-Location $sourceDirectory
try {
  python .\gen-make.py -t cmake
  Assert-NativeSuccess "Subversion CMake generation"
} finally {
  Pop-Location
}

$cmakeToolchain = Join-Path $vcpkgRoot "scripts\buildsystems\vcpkg.cmake"
$cmakeConfigureArguments = @(
  "-S"
  $sourceDirectory
  "-B"
  $buildDirectory
  "-G"
  "Ninja"
  "-DCMAKE_BUILD_TYPE:STRING=Release"
  "-DBUILD_SHARED_LIBS:BOOL=ON"
  "-DSVN_ENABLE_TESTS:BOOL=OFF"
  "-DSVN_ENABLE_RA_LOCAL:BOOL=ON"
  "-DSVN_ENABLE_RA_SERF:BOOL=OFF"
  "-DSVN_ENABLE_RA_SVN:BOOL=ON"
  "-DSVN_ENABLE_NLS:BOOL=OFF"
  "-DSVN_ENABLE_TUI:BOOL=OFF"
  "-DCMAKE_INSTALL_PREFIX:PATH=$installStaging"
  "-DCMAKE_TOOLCHAIN_FILE:FILEPATH=$cmakeToolchain"
  "-DVCPKG_TARGET_TRIPLET:STRING=x64-windows"
)
& cmake @cmakeConfigureArguments
Assert-NativeSuccess "Subversion CMake configuration"

$cmakeBuildArguments = @("--build", $buildDirectory, "--config", "Release", "--parallel")
& cmake @cmakeBuildArguments
Assert-NativeSuccess "Subversion build"
$cmakeInstallArguments = @(
  "--install"
  $buildDirectory
  "--config"
  "Release"
  "--prefix"
  $installStaging
)
& cmake @cmakeInstallArguments
Assert-NativeSuccess "Subversion installation"

$installedBin = Join-Path $installStaging "bin"
if (-not (Test-Path -LiteralPath $installedBin -PathType Container)) {
  throw "Subversion installation did not create the expected bin directory: $installedBin"
}
foreach ($requiredExecutable in @("svn.exe", "svnadmin.exe")) {
  $installedExecutable = Join-Path $installedBin $requiredExecutable
  if (-not (Test-Path -LiteralPath $installedExecutable -PathType Leaf)) {
    throw "Subversion installation is missing required executable: $installedExecutable"
  }
}

$vcpkgBin = Join-Path $vcpkgRoot "installed\x64-windows\bin"
$appLocal = Join-Path $vcpkgRoot "scripts\buildsystems\msbuild\applocal.ps1"
& $appLocal -targetBinary (Join-Path $installedBin "svn.exe") -installedDir $vcpkgBin
& $appLocal -targetBinary (Join-Path $installedBin "svnadmin.exe") -installedDir $vcpkgBin

New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
Copy-Item -LiteralPath $installedBin -Destination $runtimeRoot -Recurse

& $svnExecutable --version --quiet
Assert-NativeSuccess "svn version check"
& $svnAdminExecutable --version --quiet
Assert-NativeSuccess "svnadmin version check"
