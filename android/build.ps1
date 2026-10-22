# Builds tv-hub.apk without Gradle (aapt2 + javac + d8 + apksigner).
$ErrorActionPreference = 'Continue'   # native tools write notes to stderr; failures are checked via $LASTEXITCODE
$root  = $PSScriptRoot
$sdk   = "$env:LOCALAPPDATA\Android\Sdk"
$bt    = "$sdk\build-tools\36.0.0"
$jar   = "$sdk\platforms\android-34\android.jar"
$out   = "$root\build"
$keytool = (Get-ChildItem 'C:\Program Files\Java','C:\Program Files\Android' -Recurse -Filter keytool.exe -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
$ks    = "$root\kids-home.keystore"   # keep this file: updates must be signed with the same key
# Keystore password (AUDIT S8): environment variable TVHUB_KS_PASS, or the first line of keystore.pass next to this
# script (both kept out of version control). Back up the keystore AND its password outside this PC.
$ksPass = $env:TVHUB_KS_PASS
if (-not $ksPass -and (Test-Path "$root\keystore.pass")) { $ksPass = (Get-Content "$root\keystore.pass" -TotalCount 1).Trim() }
if (-not $ksPass) { throw 'keystore password missing: set TVHUB_KS_PASS or create keystore.pass' }

Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$out\classes", "$out\dex" | Out-Null

& "$bt\aapt2.exe" link -o "$out\base.apk" --manifest "$root\AndroidManifest.xml" -I $jar --min-sdk-version 21 --target-sdk-version 34
if ($LASTEXITCODE) { throw 'aapt2 failed' }

$src = Get-ChildItem -Recurse "$root\src" -Filter *.java | ForEach-Object FullName
javac --release 11 -encoding UTF-8 -classpath $jar -d "$out\classes" $src
if ($LASTEXITCODE) { throw 'javac failed' }

$classes = Get-ChildItem -Recurse "$out\classes" -Filter *.class | ForEach-Object FullName
& "$bt\d8.bat" --release --min-api 21 --lib $jar --output "$out\dex" $classes
if ($LASTEXITCODE) { throw 'd8 failed' }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open("$out\base.apk", 'Update')
[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, "$out\dex\classes.dex", 'classes.dex') | Out-Null
$zip.Dispose()

& "$bt\zipalign.exe" -f -p 4 "$out\base.apk" "$out\aligned.apk"
if ($LASTEXITCODE) { throw 'zipalign failed' }

if (-not (Test-Path $ks)) {
    & $keytool -genkeypair -keystore $ks -storepass $ksPass -keypass $ksPass -alias kidshome `
        -keyalg RSA -keysize 2048 -validity 36500 -dname 'CN=Kids Home' | Out-Null
}
& "$bt\apksigner.bat" sign --ks $ks --ks-pass "pass:$ksPass" --ks-key-alias kidshome --out "$root\tv-hub.apk" "$out\aligned.apk"
if ($LASTEXITCODE) { throw 'apksigner failed' }
"Built: $root\tv-hub.apk"


