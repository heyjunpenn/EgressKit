# Third-party notices

EgressKit is licensed under Apache-2.0. Its source distribution and release artifacts include the
license text in `LICENSE`.

The EgressKit Docker image redistributes the unmodified official
[MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo) executable at version `v1.19.30` as a
separate process. Mihomo is licensed under GPL-3.0. The corresponding license text is included at
`licenses/Mihomo-GPL-3.0.txt` in release archives and at
`/usr/share/licenses/egresskit/Mihomo-GPL-3.0.txt` in the image.

The exact corresponding Mihomo source can be obtained from the upstream
[`v1.19.30` source tree](https://github.com/MetaCubeX/mihomo/tree/v1.19.30) or its source archive.
EgressKit does not modify or link Mihomo; it invokes the executable through process and local HTTP
boundaries.
