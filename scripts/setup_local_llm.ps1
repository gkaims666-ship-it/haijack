# Подготовка локальной модели для Local Claude Code через Ollama (Windows).
#
#   powershell -ExecutionPolicy Bypass -File scripts\setup_local_llm.ps1 --model <имя> [--fallback <имя>] [--write-env]
#
# Проверяет, что Ollama установлена, запускает сервер, скачивает указанную модель и показывает
# строки для файла настроек. С флагом --write-env дописывает их в %USERPROFILE%\.lcc\.env.
# Нужна модель с поддержкой вызова инструментов (tool calling).
# Скачивание весов занимает от нескольких минут до часов — запускайте в своём терминале.

$ErrorActionPreference = 'Stop'

# Параметры принимаются и в виде --model (как в sh-версии), и в виде -Model
$Model = ''
$Fallback = ''
$WriteEnv = $false
for ($i = 0; $i -lt $args.Count; $i++) {
  switch -Regex ($args[$i]) {
    '^(--model|-Model)$'       { $i++; $Model = [string]$args[$i]; break }
    '^--model=(.+)$'           { $Model = $Matches[1]; break }
    '^(--fallback|-Fallback)$' { $i++; $Fallback = [string]$args[$i]; break }
    '^--fallback=(.+)$'        { $Fallback = $Matches[1]; break }
    '^(--write-env|-WriteEnv)$' { $WriteEnv = $true; break }
    default { Write-Host "Неизвестный параметр: $($args[$i])" -ForegroundColor Red; exit 2 }
  }
}
if (-not $Model) {
  Write-Host 'Укажите модель: --model <имя>, например --model qwen2.5-coder:14b' -ForegroundColor Yellow
  exit 2
}

$HostAddr = if ($env:OLLAMA_HOST) { $env:OLLAMA_HOST } else { '127.0.0.1:11434' }
$Base = if ($HostAddr -match '^https?://') { $HostAddr } else { "http://$HostAddr" }

if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  Write-Host 'Ollama не установлена.' -ForegroundColor Yellow
  Write-Host 'Установка: winget install Ollama.Ollama   (или скачайте с https://ollama.com/download)'
  exit 1
}

function Test-Ollama {
  try { Invoke-RestMethod -Uri "$Base/api/tags" -TimeoutSec 3 | Out-Null; return $true } catch { return $false }
}

if (-not (Test-Ollama)) {
  Write-Host 'Запускаю сервер Ollama…'
  Start-Process -FilePath 'ollama' -ArgumentList 'serve' -WindowStyle Hidden
  for ($n = 0; $n -lt 30 -and -not (Test-Ollama); $n++) { Start-Sleep -Seconds 1 }
  if (-not (Test-Ollama)) { Write-Host 'Сервер Ollama не запустился. Запустите приложение Ollama вручную и повторите.' -ForegroundColor Red; exit 1 }
}
Write-Host "Сервер Ollama работает: $Base"

foreach ($m in @($Model, $Fallback) | Where-Object { $_ }) {
  Write-Host "Скачиваю модель $m (может занять много времени)…"
  & ollama pull $m
  if ($LASTEXITCODE -ne 0) { Write-Host "Не удалось скачать модель $m." -ForegroundColor Red; exit $LASTEXITCODE }
}

$EnvLines = @(
  'LLM_PROVIDER=local'
  "LOCAL_LLM_BASE_URL=$Base/v1"
  'LOCAL_LLM_API_KEY=ollama'
  "LOCAL_LLM_MODEL=$Model"
  'LOCAL_LLM_NUM_CTX=16384'
  'LOCAL_LLM_TIMEOUT=180000'
)
if ($Fallback) { $EnvLines += "LOCAL_LLM_FALLBACK_MODEL=$Fallback" }

Write-Host ''
Write-Host 'Готово. Настройки для Local Claude Code:'
$EnvLines | ForEach-Object { Write-Host $_ }

if ($WriteEnv) {
  $Dir = Join-Path $env:USERPROFILE '.lcc'
  $File = Join-Path $Dir '.env'
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $Old = @()
  if (Test-Path $File) {
    $Old = Get-Content $File | Where-Object { $_ -notmatch '^(LLM_PROVIDER|LCC_PROVIDER|LCC_MODEL|LOCAL_LLM_(BASE_URL|API_KEY|MODEL|FALLBACK_MODEL|NUM_CTX|TIMEOUT))=' }
  }
  # UTF-8 без BOM: иначе первая переменная в файле не распознаётся
  [System.IO.File]::WriteAllLines($File, [string[]](@($Old) + $EnvLines), (New-Object System.Text.UTF8Encoding $false))
  Write-Host "Записано в $File"
} else {
  Write-Host ''
  Write-Host 'Добавьте эти строки в %USERPROFILE%\.lcc\.env или запустите скрипт с флагом --write-env.'
}
