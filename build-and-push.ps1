# build-and-push.ps1
# Build the dsh-telegram image (linux/arm64) tagged :latest and push it to GitHub Container Registry (ghcr.io)

param(
    [string]$Registry = "ghcr.io",
    [string]$Owner = "neoz",
    [string]$ImageName = "dsh-telegram",
    [switch]$NoPush
)

$ErrorActionPreference = "Stop"

# Ensure QEMU is set up for cross-platform builds
Write-Host "Setting up QEMU for cross-platform builds ..." -ForegroundColor Cyan
docker run --rm --privileged multiarch/qemu-user-static --reset -p yes >$null

$FullImage = "$Registry/$Owner/${ImageName}:latest"

Write-Host "Building $FullImage ..." -ForegroundColor Cyan

docker buildx build --platform linux/arm64 --provenance=false -f docker/Dockerfile -t $FullImage --load .

if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed." -ForegroundColor Red
    exit 1
}

if ($NoPush) {
    Write-Host "Build complete (push skipped)." -ForegroundColor Yellow
    exit 0
}

# Login to ghcr.io if not already authenticated
$ErrorActionPreference = "Continue"
$loginCheck = docker pull "$Registry/$Owner/${ImageName}:nonexistent" 2>&1
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

Write-Host "Pushing $FullImage ..." -ForegroundColor Cyan
docker push $FullImage

if ($LASTEXITCODE -ne 0) {
    Write-Host "Push failed." -ForegroundColor Red
    exit 1
}

Write-Host "Done: $FullImage" -ForegroundColor Green
