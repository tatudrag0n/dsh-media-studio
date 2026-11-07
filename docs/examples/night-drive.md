# 夜のドライブ PV の作り方

手順書と一緒にプロジェクトを管理する例です。`.md` ファイルを渡すと、最初の
コードフェンス（yaml か json）の中身をプロジェクトとして読みます。

```yaml
version: 1
title: 夜のドライブ PV
steps:
  - id: cover
    tool: generate_image
    args:
      prompt: 夜の海沿いの道路、ネオン、シネマティック
      aspect: landscape
  - id: bgm
    tool: compose_music
    args:
      prompt: シティポップ、92 BPM
      bars: 8
  - id: cut
    tool: edit_video
    args:
      timeline:
        tracks:
          - type: video
            clips:
              - path: $cover
                duration: 4
          - type: audio
            clips:
              - path: $bgm
                volume: 0.4
      name: night-drive
```

## 実行

```
render_project path="docs/examples/night-drive.md"
node cli.mjs render docs/examples/night-drive.md
```

## メモ

- カバー画像は 16:9（`aspect: landscape`）。
- BGM は 20 秒作って、動画は 4 秒だけ使う。
- `$cover` / `$bgm` は前のステップの成果物のパスに置き換わる。
