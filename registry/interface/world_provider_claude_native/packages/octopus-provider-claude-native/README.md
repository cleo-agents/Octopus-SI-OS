# octopus-provider-claude-native

The provider life of `world_provider_claude_native`. It reads its own
movements, runs each declared input as a Claude Code turn through the SDK
child in `../octopus-claude-sdk-child`, exposes the invocation's admitted
tools to Claude, and hands replies, tool calls and failures through
`octopus-run-authoring`.

## Which Claude Code it runs

`private_config.sdk_child.claude_executable` names the Claude Code executable.
The default, `claude`, is looked up on the runtime's `PATH` and is granted by
`authority.executable_commands` in `life.json`. To use a specific install,
set it to an absolute path and add exactly that path to
`authority.executable_paths`. Both fields are declared package configuration,
so they survive package repair. The doctor and the life refuse to start
while the configured executable is not granted.

Claude Code keeps its own sign-in. On macOS a claude.ai sign-in is read from
the login Keychain, which `life.json` grants through `/usr/bin/security` and
read access to `~/Library/Keychains`.
