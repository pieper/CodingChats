# CodingChats

A VS Code extension that automatically captures [Claude Code](https://claude.com/claude-code) conversation transcripts and commits them to a git repository.

The goal is to preserve the full back-and-forth of AI-assisted coding sessions — not just the final commits, but the prompts, dead ends, corrections, and reasoning that led to the code. This is valuable for:

- **Future developers** doing `git blame` who want to understand *why* code was written a certain way
- **Future AI agents** learning what prompts and approaches work (and what leads to dead ends)
- **Knowledge sharing** — making selected conversations public to help others learn effective AI collaboration patterns

## How it works

1. Claude Code writes conversation transcripts as JSONL files in `~/.claude/projects/`
2. This extension watches that directory for changes
3. When a session goes idle (configurable debounce), it copies the transcript to your conversations git repo and commits it
4. An `INDEX.md` file is maintained with a table linking to each conversation with date, project, and summary

## Quick Setup

### 1. Create your private conversations repo on GitHub

```bash
gh repo create CodingChats-conversations --private --clone
cd CodingChats-conversations
mkdir sessions
touch sessions/.gitkeep
cat > INDEX.md << 'EOF'
# Coding Conversations Index

| Date | Machine | Project | Session | Summary |
|------|---------|---------|---------|---------|
EOF
git add .
git commit -m "Initial conversations repo"
git push -u origin main
```

### 2. Build the extension

Requires Node.js >= 20.

```bash
git clone https://github.com/pieper/CodingChats.git
cd CodingChats
npm install
npm run compile
npm run package
```

This produces a `coding-chats-<version>.vsix` file in the project directory.

### 3. Install the extension

**From the command line:**

```bash
code --install-extension coding-chats-0.1.0.vsix
```

**From the VS Code GUI:**

1. Open the Extensions sidebar (**Cmd+Shift+X** / **Ctrl+Shift+X**)
2. Click the `...` menu at the top of the sidebar
3. Choose **Install from VSIX...** and select the `.vsix` file

After installing, reload the window (**Cmd+Shift+P** / **Ctrl+Shift+P** → **Developer: Reload Window**) to activate the extension.

**For development**, open the CodingChats folder in VS Code and press **F5** to launch an Extension Development Host with the extension loaded.

### 4. Configure (optional)

On first activation, the extension will prompt you to choose where to store conversations — you can use the default (`~/CodingChats-conversations`), pick a custom location, or point it at an existing repo. To change this later, run **CodingChats: Change Conversations Repo Location** from the command palette.

You can also configure settings directly in `settings.json`:

Open VS Code Settings and search for "CodingChats", or add to your `settings.json`:

```json
{
  "codingChats.conversationsRepoPath": "/Users/you/CodingChats-conversations",
  "codingChats.autoCommit": true,
  "codingChats.autoPush": true,
  "codingChats.debounceSeconds": 30
}
```

### 5. Push conversations to GitHub

If you set `codingChats.autoPush` to `true`, conversations are pushed automatically after each commit.

Otherwise, push manually whenever you like:

```bash
cd ~/CodingChats-conversations
git push
```

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `codingChats.conversationsRepoPath` | `~/CodingChats-conversations` | Path to the local git repo for storing conversations |
| `codingChats.autoCommit` | `true` | Auto-commit when sessions go idle |
| `codingChats.autoPush` | `false` | Auto-push after each commit |
| `codingChats.debounceSeconds` | `30` | Seconds to wait after last change before committing |
| `codingChats.claudeProjectsPath` | `~/.claude/projects` | Path to Claude Code's transcript directory |

## Commands

- **CodingChats: Commit Conversations Now** — immediately commit all tracked sessions
- **CodingChats: Open Latest Conversation** — open the INDEX.md in the conversations repo
- **CodingChats: Show Status** — show tracking status in the output panel
- **CodingChats: Import Existing Conversations** — import transcripts from Claude Code's projects directory
- **CodingChats: Change Conversations Repo Location** — re-run the initial setup dialog to pick a new repo location (useful if you moved or deleted the conversations repo, or want to switch to a different one)

## Multi-machine support

The extension is designed to work across multiple computers sharing the same conversations repo via git. Enable `autoPush` on each machine, and:

- **Pull before commit**: the extension automatically pulls remote changes (with rebase) before each commit, so changes from other machines are incorporated
- **Append-only INDEX.md**: new entries are appended at the end of the table, which minimizes merge conflicts when both machines commit concurrently
- **Machine tracking**: each INDEX.md entry and commit message records the hostname, so you can see which machine produced each conversation

On first install, the extension checks GitHub (via `gh`) for an existing `CodingChats-conversations` repo and offers to clone it automatically — so setting up a second machine is just "install the extension and accept the prompt."

### Rebuilding from scratch

If you need to start fresh (e.g. to pick up a new INDEX.md format), you can rebuild the conversations repo without losing any data. Your original transcripts are always preserved in `~/.claude/projects/`.

1. **Delete or rename the old local repo:**
   ```bash
   mv ~/CodingChats-conversations ~/CodingChats-conversations.bak
   ```

2. **Optionally delete the GitHub repo too** (if you want a clean remote):
   ```bash
   gh repo delete CodingChats-conversations --yes
   ```

3. **Re-run setup** — open the command palette and run **CodingChats: Change Conversations Repo Location**. This re-runs the first-install flow: it will create a fresh repo (or let you create one on GitHub first and clone it).

4. **Re-import all conversations** — open the command palette and run **CodingChats: Import Existing Conversations**. The extension scans `~/.claude/projects/` for all transcripts, skips any that are already in the repo (matched by session ID), and imports the rest. This is safe to run at any time — it won't create duplicates.

## Repository structure (conversations repo)

```
CodingChats-conversations/
  INDEX.md                          # table of all conversations
  sessions/
    <project-name-or-hash>/
      2026-03-11-<session-id>.jsonl  # raw transcript
      2026-03-12-<session-id>.jsonl
    <another-project>/
      ...
```

Each `.jsonl` file contains the full Claude Code conversation transcript — one JSON object per line, including user messages, assistant responses, tool calls, and tool results.

## Making conversations public

Your conversations repo starts private. To share specific conversations:

1. **Make the whole repo public** when you're comfortable:
   ```bash
   gh repo edit CodingChats-conversations --visibility public
   ```

2. **Or selectively share** by copying specific `.jsonl` files to a public repo.

3. **Or use GitHub's fine-grained access** to share with specific collaborators.

## Integration with AI skill systems

This extension is designed to work with AI skill/knowledge systems. For example, with the [slicer-skill](https://github.com/pieper/slicer-skill), conversation logs can be included as a searchable resource that helps future agents understand how code was developed.

To make your conversations available to a skill's setup script:

```bash
# In your skill's setup.sh, clone the conversations repo
git clone https://github.com/youruser/CodingChats-conversations.git coding-chats
```

Agents can then search the JSONL transcripts for relevant past conversations:

```bash
grep -rn "segmentation" coding-chats/sessions/
```

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details.
