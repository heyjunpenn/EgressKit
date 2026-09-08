# Mihomo runtime

EgressKit integrates Mihomo as a separate GPL-3.0 process. Dependency installation never downloads
Mihomo: the repository has no runtime download in `postinstall` or `prepare`.

## Explicit installation

Run the installer explicitly:

```sh
egresskit runtime install
```

The default destination is `$EGRESSKIT_STATE_DIRECTORY/mihomo/mihomo` (or the default EgressKit
state directory). Use `--destination /absolute/path/to/mihomo` to choose another location. The
installer downloads exactly Mihomo `v1.19.30` from the official `MetaCubeX/mihomo` GitHub release,
checks the compressed asset's pinned SHA-256 before extracting it, and writes the executable
atomically with private permissions.

Supported targets and pinned official assets:

| Platform | Asset | SHA-256 |
| --- | --- | --- |
| macOS arm64 | `mihomo-darwin-arm64-v1.19.30.gz` | `2c7f3a7904fa1cee291e124123e630e7b1ebd13765dd9bf26c0a28432004d9f4` |
| macOS x64 | `mihomo-darwin-amd64-compatible-v1.19.30.gz` | `6e75de0732e8afabe413ff7c235e8f16226ce136672371c60787cbf9607402c5` |
| Linux arm64 | `mihomo-linux-arm64-v1.19.30.gz` | `58896873736d28628f66de3677c8654fa0f180662523148e136cff4f6e890069` |
| Linux x64 | `mihomo-linux-amd64-compatible-v1.19.30.gz` | `db214c7a2517e63c150d123178d16d102e03a241ccdae4e5e07ffbe9cf56c6f9` |

Other platform/architecture pairs fail as unsupported; the installer also reports download,
checksum, and executable failures as distinct error codes.

## Existing binary

To use an already installed executable, start the daemon with:

```sh
EGRESSKIT_MIHOMO_BINARY=/absolute/path/to/mihomo egressd
```

EgressKit checks that an explicitly configured path is executable before starting the daemon.
