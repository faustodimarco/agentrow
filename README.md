# agentrow

Persistent coding agents you can drive from your terminal **and from Telegram**.

A background daemon owns real terminals (PTYs) for your agents — Claude Code, Codex, Gemini, opencode, plain shells… — grouped into **workspaces** (folders). Close the terminal, the agents keep working. Each agent gets its own **Telegram forum topic**: write there to prompt it, get a message when it finishes or needs approval, answer dialogs with buttons.

```
agentrow daemon (launchd / systemd)
├── workspace api      ~/code/api
│   ├── api/claude     🟡 working
│   └── api/review     🟢 idle
└── workspace web      ~/code/web
    └── web/fix        🔴 blocked  → Telegram: "needs you" + [Yes] [No] buttons
```

## Install

The repository is private, so downloads use your GitHub login (`gh auth login`) or `$GITHUB_TOKEN`.

**macOS / Linux**

```sh
curl -fsSL -H "Authorization: Bearer $(gh auth token)" https://raw.githubusercontent.com/faustodimarco/agentrow/main/install.sh | sh
```

**Windows** (PowerShell; runs agentrow inside WSL)

```powershell
irm -Headers @{Authorization="Bearer $(gh auth token)"} https://raw.githubusercontent.com/faustodimarco/agentrow/main/install.ps1 | iex
```

The Unix installer puts a single binary at `~/.local/bin/agentrow` (override with `AGENTROW_INSTALL_DIR`, pin a release with `AGENTROW_VERSION=v0.1.0`) and verifies its SHA-256. Builds: macOS arm64/x64, Linux x64/arm64. Binaries are also on the [releases page](https://github.com/faustodimarco/agentrow/releases).

On Windows, agentrow needs a Unix PTY, so the installer sets it up inside WSL (run `wsl --install` first if you don't have it), adds an `agentrow` command to Windows that forwards to WSL, and registers an `agentrow` logon task that starts the daemon and keeps WSL running. Install your agent CLIs (Claude Code, Codex…) inside WSL too.

Then keep the daemon running across logins and crashes:

```sh
agentrow install    # macOS: launchd LaunchAgent · Linux/WSL: systemd user service
```

Without `install`, any command starts the daemon detached from your terminal.

### From source

Requires [Bun](https://bun.sh) ≥ 1.3.5 (native PTY support): `bun install && bun link`.

### Releasing

Bump `version` in `package.json`, commit, then `scripts/release.sh`: it cross-compiles every target, writes `SHA256SUMS`, pushes, and publishes the GitHub release.

## Terminal

```sh
agentrow ws new api ~/code/api             # workspace = a folder
agentrow new api/claude                    # Claude Code in ~/code/api
agentrow new api/review --kind codex -- -m gpt-5.4
agentrow new api/tests --kind shell --cwd packages/core

agentrow ls                                # agents + state
agentrow attach api/claude                 # full terminal; Ctrl+] detaches
agentrow prompt claude "fix the failing test" --wait
agentrow read claude --lines 60
agentrow keys claude esc                   # esc, enter, tab, shift+tab, up, down, ctrl+c, 1, y…
agentrow wait claude --until blocked
agentrow restart claude                    # Claude resumes the same conversation
agentrow stop claude | rm claude
```

Agents are addressed as `ws/name`, or just `name` when unique. States: `starting`, `working`, `blocked` (approval/question dialog on screen), `idle`, `exited`.

## Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. `agentrow telegram setup <token>` — prints a pairing code.
3. Create a Telegram group, enable **Topics** in its settings, add the bot as admin with **Manage Topics**.
4. Send `/pair <code>` in the group. You become the only allowed user; every agent gets a topic.

**General topic** (control):

| Command | |
| --- | --- |
| `/ws` | workspaces, agents, state, links to topics |
| `/ws_new <name> <path>` · `/ws_rm <name> [force]` | manage workspaces |
| `/ls [path]` | browse folders to pick a workspace root |
| `/new <ws> <name> [kind] [args…]` | start an agent (creates its topic) |
| `/agents [ws]` | list agents |
| `/stop` · `/restart` · `/rm <agent>` | lifecycle |

**Agent topic**: any text is a prompt (acknowledged with 👀). `/read [lines]`, `/status`, `/esc`, `/enter`, `/ctrlc`, `/keys <key…>`, `/stop`, `/restart`. Other slash commands (`/compact`, `/model`…) are passed to the agent.

**Notifications** in each topic:
- 🔴 **needs you** — the dialog text plus one button per option, and Esc/Enter.
- ✅ **done** — Claude's reply text (read from its transcript), otherwise the screen tail. Plain shells only report done after a prompt you sent.
- ⚫ **exited** / ⏹ **stopped** — with a Restart button.

Only the paired user in the paired group can control agents; everything else is ignored. To allow more people, add their Telegram user ids to `allowedUserIds` in `~/.agentrow/config.json` and restart the daemon (`agentrow stop && agentrow start`).

## Files

`~/.agentrow/` (override with `AGENTROW_HOME`): `state.json` (workspaces, agents), `config.json` (Telegram, PTY size), `daemon.log`, `agentrow.sock`.

On daemon start every agent that was running is relaunched; Claude Code agents resume their pinned session (`--resume <id>`), Codex uses `codex resume --last`.
