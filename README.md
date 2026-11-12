# Token Pulse

Token Pulse is an Orca sidebar plugin for tracking token usage, generation speed, model pricing, and live input/output telemetry across Claude Code, Codex, Gemini CLI, and Antigravity.

## Install

From Orca's plugin directory, search for **Token Pulse**. You can also install the repository directly:

```bash
orca plugin install wilsonliu123/orca-token-used
```

The plugin uses Orca's `trusted-worker` profile. Orca will show the requested access and ask you to approve it before the worker runs.

## Features

- Live output and input token rates with 60-second waveforms.
- Session, day, week, and month token summaries.
- Claude Code, Codex, Gemini CLI, and Antigravity transcript parsing.
- Current model labels and provider-aware USD estimates.
- Online pricing refresh from OpenRouter and models.dev, with offline built-in rates.
- Light and dark Orca themes.

## Data access and privacy

The worker reads local agent transcripts and Orca's local session journal to calculate usage. It reads the local Claude Code, Codex, Gemini, Antigravity, and Orca application data paths needed for those calculations.

The only outbound requests are public pricing reads from:

- `https://openrouter.ai/api/v1/models`
- `https://models.dev/api.json`

Transcript contents, prompts, responses, and local paths are not sent to those endpoints. Token Pulse has no analytics, telemetry, advertising, or account sign-in flow.

## Settings

| Setting | Default | Description |
| --- | ---: | --- |
| Live pricing sync interval | 6 hours | How often online model rates are refreshed. |
| Live transcript refresh interval | 2 seconds | How often active transcripts are tailed. |

## Development

```bash
orca plugin dev watch .
orca plugin validate .
orca plugin test .
```

The plugin requires Orca `>=1.4.248`.

## Releases

Release a new version with:

```bash
scripts/publish-plugin.sh 0.1.1
```

The script updates the manifest version, validates and tests the plugin, commits the release, pushes `main`, creates the matching `v0.1.1` tag, and prints the Orca directory URL.

## License

MIT
