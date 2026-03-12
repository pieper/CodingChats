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

| Date | Project | Session | Summary |
|------|---------|---------|---------|
EOF
git add .
git commit -m "Initial conversations repo"
git push -u origin main
```

### 2. Install the extension

Clone this repo and build:

```bash
git clone https://github.com/pieper/CodingChats.git
cd CodingChats
npm install
npm run compile
npm run package
code --install-extension coding-chats-*.vsix
```

Or for development, open the CodingChats folder in VS Code and press F5 to launch with the extension loaded.

### 3. Configure (optional)

The extension works with zero configuration — it will create `~/CodingChats-conversations` automatically if it doesn't exist. To point it at your cloned GitHub repo instead:

Open VS Code Settings and search for "CodingChats", or add to your `settings.json`:

```json
{
  "codingChats.conversationsRepoPath": "/Users/you/CodingChats-conversations",
  "codingChats.autoCommit": true,
  "codingChats.autoPush": true,
  "codingChats.debounceSeconds": 30
}
```

### 4. Push conversations to GitHub

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
