# build-and-push.ps1
# Build the dsh-telegram and dsh-zalo images (linux/arm64) tagged :latest and push them to GitHub Container Registry (ghcr.io).
# -Target telegram or -Target zalo builds only that one.

param(
    [string]$Registry = "ghcr.io",
    [string]$Owner = "neoz",
    [ValidateSet("all", "telegram", "zalo")]
    [string]$Target = "all",
    [switch]$NoPush
)

$ErrorActionPreference = "Stop"

$Images = @(
    @{ Name = "telegram"; Image = "dsh-telegram"; Dockerfile = "docker/Dockerfile" },
    @{ Name = "zalo"; Image = "dsh-zalo"; Dockerfile = "docker/zalo.Dockerfile" }
) | Where-Object { $Target -eq "all" -or $_.Name -eq $Target }

# Ensure QEMU is set up for cross-platform builds
Write-Host "Setting up QEMU for cross-platform builds ..." -ForegroundColor Cyan
docker run --rm --privileged multiarch/qemu-user-static --reset -p yes >$null

# Build everything first, so a failed build never leaves the registry with only some images updated.
foreach ($entry in $Images) {
    $FullImage = "$Registry/$Owner/$($entry.Image):latest"
    Write-Host "Building $FullImage ..." -ForegroundColor Cyan
    docker buildx build --platform linux/arm64 --provenance=false -f $entry.Dockerfile -t $FullImage --load .
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Build of $FullImage failed." -ForegroundColor Red
        exit 1
    }
}

if ($NoPush) {
    Write-Host "Build complete (push skipped)." -ForegroundColor Yellow
    exit 0
}

# Login to ghcr.io if not already authenticated
$ErrorActionPreference = "Continue"
$loginCheck = docker pull "$Registry/$Owner/$($Images[0].Image):nonexistent" 2>&1
$ErrorActionPreference = "Stop"
if ($loginCheck -match "unauthorized" -or $loginCheck -match "denied") {
    Write-Host "Logging in to $Registry ..." -ForegroundColor Cyan
    Write-Host "Provide a GitHub PAT with write:packages scope:" -ForegroundColor Yellow
    $token = Read-Host -AsSecureString "Token"
    $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($token)
    )
    $plainToken | docker login $Registry -u $Owner --password-stdin
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Login failed." -ForegroundColor Red
        exit 1
    }
}

foreach ($entry in $Images) {
    $FullImage = "$Registry/$Owner/$($entry.Image):latest"
    Write-Host "Pushing $FullImage ..." -ForegroundColor Cyan
    docker push $FullImage
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Push of $FullImage failed." -ForegroundColor Red
        exit 1
    }
    Write-Host "Done: $FullImage" -ForegroundColor Green
}
