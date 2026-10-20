param()

$ErrorActionPreference = 'Stop'
$appRoot = if ($env:SAFE_EDGE_CODEX_APP_ROOT) { $env:SAFE_EDGE_CODEX_APP_ROOT } else { Join-Path $env:LOCALAPPDATA 'OpenAI\Codex' }
$runtimeRoot = Join-Path $appRoot 'runtimes\cua_node'
$bridgeScript = Join-Path $PSScriptRoot 'safe_edge_bridge_mcp.mjs'

# The bridge resolves caller identity and Statsig policy via chatgpt.com on
# startup. Honor the user's existing proxy configuration and keep loopback
# direct. Set HTTP_PROXY/HTTPS_PROXY before launching if a proxy is needed.
$env:NODE_USE_ENV_PROXY = '1'
$env:NO_PROXY = (@($env:NO_PROXY, 'localhost', '127.0.0.1') | Where-Object { $_ }) -join ','

$nodeExe = Get-ChildItem -LiteralPath $runtimeRoot -Directory |
    ForEach-Object {
        $candidate = Join-Path $_.FullName 'bin\node.exe'
        if (Test-Path -LiteralPath $candidate) {
            Get-Item -LiteralPath $candidate
        }
    } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1 -ExpandProperty FullName

if (-not $nodeExe) {
    throw "No Codex Node runtime found under $runtimeRoot"
}
if (-not (Test-Path -LiteralPath $bridgeScript)) {
    throw "Safe Edge bridge script is missing: $bridgeScript"
}

& $nodeExe $bridgeScript
exit $LASTEXITCODE
