**Breaking**: This library now uses the [matrix-bot-sdk](https://github.com/turt2live/matrix-bot-sdk) for Matrix requests. Previously, the bridge used the matrix-js-sdk which
is now deprecated in this release, but can still be accessed via `Intent.getClient()`.
