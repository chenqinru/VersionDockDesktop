param(
  [Parameter(Mandatory = $true)]
  [string]$ArtifactsFile
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$executables = @(Get-Content -LiteralPath $ArtifactsFile -Encoding utf8 | ForEach-Object {
  $artifact = $_ | ConvertFrom-Json
  if ($artifact.reason -eq "compiler-artifact" -and $artifact.profile.test -and $artifact.executable) {
    $artifact.executable
  }
} | Sort-Object -Unique)
if ($executables.Count -eq 0) {
  throw "Cargo did not report any test executables"
}

$sdkBin = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
$manifestTool = Get-ChildItem -Path "$sdkBin\*\x64\mt.exe" -File |
  Sort-Object { [version]$_.Directory.Parent.Name } -Descending |
  Select-Object -First 1
if (-not $manifestTool) {
  throw "Windows SDK manifest tool mt.exe was not found"
}

$manifestOutput = Join-Path $env:RUNNER_TEMP "versiondock-test-manifest.xml"
foreach ($executable in $executables) {
  & $manifestTool.FullName -nologo "-inputresource:$executable;#1" "-out:$manifestOutput"
  if ($LASTEXITCODE -ne 0) {
    throw "Test executable has no readable application manifest: $executable"
  }
  [xml]$manifest = Get-Content -LiteralPath $manifestOutput -Raw -Encoding utf8
  $namespaces = [System.Xml.XmlNamespaceManager]::new($manifest.NameTable)
  $namespaces.AddNamespace("asm", "urn:schemas-microsoft-com:asm.v1")
  $controls = $manifest.SelectSingleNode("/asm:assembly/asm:dependency/asm:dependentAssembly/asm:assemblyIdentity[@name='Microsoft.Windows.Common-Controls' and @version='6.0.0.0']", $namespaces)
  if (-not $controls) {
    throw "Test executable is missing the Common-Controls v6 dependency: $executable"
  }
  Write-Host "Verified Common-Controls v6 manifest: $executable"
}
