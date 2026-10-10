# WinGet Action

Yet another way to publish Windows Programs to [WinGet](https://github.com/microsoft/winget-pkgs) via [Komac](https://github.com/russellbanks/Komac)

but simple and that's it lmao

## Usage

```yaml
name: winget

on:
  release:
    types: [published]

jobs:
  winget:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: ehshit/winget-action@v1
        with:
          package-id: Eh.clipboard
          asset-pattern: 'EhClipboardSetup\.exe$'
          fork-owner: your-username
          token: ${{ secrets.WINGET_PUSH_TOKEN }}
```

Setup:

1. have a fork of [`microsoft/winget-pkgs`](https://github.com/microsoft/winget-pkgs), if not fork it
2. Make a PAT with `repo` scope, then save it as a secret
3. Pass variable to action!

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `package-id` | yes | | winget package identifier, e.g. `Eh.clipboard` |
| `asset-pattern` | yes | | regex matched against release asset filenames |
| `fork-owner` | yes | | GitHub user/org owning the `winget-pkgs` fork |
| `token` | yes | | PAT with repo scope (fork push + PR) |
| `version` | no | release tag | override version |
| `repository` | no | calling repo | `owner/repo` to publish from |
| `komac-version` | no | `2.13.0` | komac version (no leading `v`) |

## Outputs

| Output | Description |
| --- | --- |
| `pr` | winget-pkgs PR number |
| `version` | resolved version |