# CI only (GitHub-hosted Windows runner): installs Certum SimplySign Desktop, logs it in with the account e-mail and a
# TOTP code computed from the activation seed, waits until the cloud certificate is mounted in CurrentUser\My, and
# writes its thumbprint to -OutFile. build/win-sign.cjs then signs with signtool /sha1 <thumbprint>.
#
# SimplySign Desktop has no command-line login, so the login window is driven with SendKeys (the approach the
# community actions use). That is the fragile part: if Certum changes the window, this fails loudly and the build
# stops; the manual release flow (scripts/sign-win-release.mjs) still works.
#
# Inputs (environment): CHARTMATE_CERTUM_USERNAME, CHARTMATE_CERTUM_OTP_URI, CHARTMATE_WIN_PUBLISHER_NAME (required);
# CHARTMATE_CERTUM_SIMPLYSIGN_VERSION, CHARTMATE_CERTUM_SIMPLYSIGN_MSI_SHA256 (optional). Secrets are never written to the log or disk.
param([Parameter(Mandatory = $true)][string]$OutFile)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

function Log([string]$m) { Write-Host "certum-login: $m" }

foreach ($k in 'CHARTMATE_CERTUM_USERNAME', 'CHARTMATE_CERTUM_OTP_URI', 'CHARTMATE_WIN_PUBLISHER_NAME') {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($k))) { throw "$k is not set" }
}
$publisher = $env:CHARTMATE_WIN_PUBLISHER_NAME.Trim()
$version = if ([string]::IsNullOrWhiteSpace($env:CHARTMATE_CERTUM_SIMPLYSIGN_VERSION)) { '9.4.4.92' } else { $env:CHARTMATE_CERTUM_SIMPLYSIGN_VERSION.Trim() }
if ($version -notmatch '^\d+(\.\d+){1,3}$') { throw "invalid CHARTMATE_CERTUM_SIMPLYSIGN_VERSION" }
$totpScript = Join-Path $PSScriptRoot 'totp.mjs'

# 1. Download and verify the installer: it must carry a valid Authenticode signature from Asseco Data Systems
#    (Certum's operator); optionally also a pinned SHA-256.
$msi = Join-Path $env:RUNNER_TEMP "SimplySignDesktop-$version.msi"
$url = "https://files.certum.eu/software/SimplySignDesktop/Windows/$version/SimplySignDesktop-$version-64-bit-en.msi"
Log "downloading SimplySign Desktop $version"
for ($i = 1; ; $i++) {
  try { Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing; break }
  catch { if ($i -ge 3) { throw }; Start-Sleep -Seconds (5 * $i) }
}
$sig = Get-AuthenticodeSignature -FilePath $msi
if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Asseco Data Systems') {
  throw "SimplySign installer signature is not a valid Asseco Data Systems signature ($($sig.Status): $($sig.SignerCertificate.Subject))"
}
if (-not [string]::IsNullOrWhiteSpace($env:CHARTMATE_CERTUM_SIMPLYSIGN_MSI_SHA256)) {
  $hash = (Get-FileHash -Algorithm SHA256 -Path $msi).Hash
  if ($hash -ne $env:CHARTMATE_CERTUM_SIMPLYSIGN_MSI_SHA256.Trim().ToUpper()) { throw "SimplySign installer SHA-256 mismatch ($hash)" }
}

# 2. Install silently.
$p = Start-Process msiexec.exe -ArgumentList @('/i', "`"$msi`"", '/qn', '/norestart') -Wait -PassThru
if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw "SimplySign Desktop install failed ($($p.ExitCode))" }
$exe = Get-ChildItem -Path "$env:ProgramFiles\Certum", "${env:ProgramFiles(x86)}\Certum" -Recurse -Filter 'SimplySignDesktop.exe' -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty FullName
if (-not $exe) { throw 'SimplySignDesktop.exe not found after install' }

function Find-Certificate {
  Get-ChildItem Cert:\CurrentUser\My | Where-Object {
    $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) -and
    $_.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -eq $publisher -and
    ($_.EnhancedKeyUsageList | Where-Object { $_.ObjectId -eq '1.3.6.1.5.5.7.3.3' })
  } | Sort-Object NotAfter -Descending | Select-Object -First 1
}

function Escape-SendKeys([string]$s) { ($s.ToCharArray() | ForEach-Object { if ('+^%~(){}[]'.Contains($_)) { "{$_}" } else { "$_" } }) -join '' }

Add-Type -AssemblyName System.Windows.Forms
$shell = New-Object -ComObject WScript.Shell

# 3. Log in. At most two attempts: wrong codes must not lock the SimplySign account.
$cert = $null
for ($attempt = 1; $attempt -le 2 -and -not $cert; $attempt++) {
  Get-Process SimplySignDesktop -ErrorAction SilentlyContinue | Stop-Process -Force
  $proc = Start-Process -FilePath $exe -PassThru
  $active = $false
  for ($i = 0; $i -lt 60 -and -not $active; $i++) {
    Start-Sleep -Milliseconds 500
    $active = $shell.AppActivate($proc.Id) -or $shell.AppActivate('SimplySign Desktop')
  }
  if (-not $active) { throw 'SimplySign Desktop login window did not appear' }
  Start-Sleep -Milliseconds 800
  [System.Windows.Forms.SendKeys]::SendWait((Escape-SendKeys $env:CHARTMATE_CERTUM_USERNAME.Trim()))
  [System.Windows.Forms.SendKeys]::SendWait('{TAB}')
  # The code is computed at the last moment, with at least 8 s of validity left.
  $code = (& node $totpScript --min-remaining=8)
  if ($LASTEXITCODE -ne 0 -or $code -notmatch '^\d{6,10}$') { throw 'could not compute the SimplySign one-time code' }
  [void]$shell.AppActivate($proc.Id)
  [System.Windows.Forms.SendKeys]::SendWait($code)
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  $code = $null
  Log "login submitted (attempt $attempt), waiting for the certificate"
  for ($i = 0; $i -lt 45 -and -not $cert; $i++) { Start-Sleep -Seconds 2; $cert = Find-Certificate }
}
if (-not $cert) { throw "no code-signing certificate for '$publisher' appeared in CurrentUser\My (check CHARTMATE_WIN_PUBLISHER_NAME and the SimplySign login)" }

Log "certificate mounted: $($cert.Subject), valid until $($cert.NotAfter.ToString('yyyy-MM-dd'))"
Set-Content -Path $OutFile -Value $cert.Thumbprint -NoNewline -Encoding ascii
