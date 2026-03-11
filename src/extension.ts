import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

interface TranscriptEntry {
  type?: string;
  role?: string;
  content?: unknown;
  tool_name?: string;
  timestamp?: string;
  [key: string]: unknown;
}

interface SessionInfo {
  projectHash: string;
  sessionId: string;
  transcriptPath: string;
  lastSize: number;
  debounceTimer?: ReturnType<typeof setTimeout>;
}

let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let fileWatchers: fs.FSWatcher[] = [];
let activeSessions: Map<string, SessionInfo> = new Map();

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("CodingChats");
  log("CodingChats extension activated");

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    10
  );
  statusBarItem.command = "codingChats.showStatus";
  statusBarItem.text = "$(comment-discussion) CodingChats";
  statusBarItem.tooltip = "CodingChats: watching for conversations";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("codingChats.commitNow", commitNow)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codingChats.openConversation",
      openLatestConversation
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("codingChats.showStatus", showStatus)
  );

  startWatching();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codingChats")) {
        stopWatching();
        startWatching();
      }
    })
  );
}

export function deactivate() {
  stopWatching();
  // Flush any pending commits
  for (const session of activeSessions.values()) {
    if (session.debounceTimer) {
      clearTimeout(session.debounceTimer);
    }
  }
  commitNow();
}

function getConfig() {
  const config = vscode.workspace.getConfiguration("codingChats");
  const claudeProjectsPath =
    config.get<string>("claudeProjectsPath") ||
    path.join(os.homedir(), ".claude", "projects");
  const conversationsRepoPath =
    config.get<string>("conversationsRepoPath") ||
    path.join(os.homedir(), "CodingChats-conversations");
  const autoCommit = config.get<boolean>("autoCommit", true);
  const autoPush = config.get<boolean>("autoPush", false);
  const debounceSeconds = config.get<number>("debounceSeconds", 30);
  return {
    claudeProjectsPath,
    conversationsRepoPath,
    autoCommit,
    autoPush,
    debounceSeconds,
  };
}

function log(msg: string) {
  const timestamp = new Date().toISOString();
  outputChannel.appendLine(`[${timestamp}] ${msg}`);
}

function startWatching() {
  const { claudeProjectsPath } = getConfig();

  if (!fs.existsSync(claudeProjectsPath)) {
    log(`Claude projects directory not found: ${claudeProjectsPath}`);
    log("Will retry when directory appears...");
    // Watch parent dir for creation
    const parentDir = path.dirname(claudeProjectsPath);
    if (fs.existsSync(parentDir)) {
      const parentWatcher = fs.watch(parentDir, (event, filename) => {
        if (filename === path.basename(claudeProjectsPath)) {
          parentWatcher.close();
          startWatching();
        }
      });
      fileWatchers.push(parentWatcher);
    }
    return;
  }

  log(`Watching for transcripts in: ${claudeProjectsPath}`);

  // Watch the projects directory for new project hash directories
  const projectsWatcher = fs.watch(
    claudeProjectsPath,
    { recursive: true },
    (event, filename) => {
      if (!filename || !filename.endsWith(".jsonl")) {
        return;
      }
      const fullPath = path.join(claudeProjectsPath, filename);
      handleTranscriptChange(fullPath);
    }
  );
  fileWatchers.push(projectsWatcher);

  // Scan for existing JSONL files
  scanExistingTranscripts(claudeProjectsPath);
}

function stopWatching() {
  for (const watcher of fileWatchers) {
    watcher.close();
  }
  fileWatchers = [];
}

function scanExistingTranscripts(projectsDir: string) {
  try {
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectDir = path.join(projectsDir, entry.name);
      try {
        const files = fs.readdirSync(projectDir);
        for (const file of files) {
          if (file.endsWith(".jsonl")) {
            const fullPath = path.join(projectDir, file);
            // Track but don't immediately commit existing files
            const stat = fs.statSync(fullPath);
            const sessionId = path.basename(file, ".jsonl");
            activeSessions.set(fullPath, {
              projectHash: entry.name,
              sessionId,
              transcriptPath: fullPath,
              lastSize: stat.size,
            });
          }
        }
      } catch {
        // Skip unreadable directories
      }
    }
    log(`Found ${activeSessions.size} existing transcript(s)`);
  } catch {
    log(`Could not scan projects directory`);
  }
}

function handleTranscriptChange(transcriptPath: string) {
  const { debounceSeconds, autoCommit } = getConfig();

  if (!fs.existsSync(transcriptPath)) return;

  const stat = fs.statSync(transcriptPath);
  const existing = activeSessions.get(transcriptPath);

  if (existing && stat.size === existing.lastSize) {
    return; // No actual change
  }

  const projectHash = path.basename(path.dirname(transcriptPath));
  const sessionId = path.basename(transcriptPath, ".jsonl");

  const session: SessionInfo = {
    projectHash,
    sessionId,
    transcriptPath,
    lastSize: stat.size,
  };

  // Clear previous debounce timer
  if (existing?.debounceTimer) {
    clearTimeout(existing.debounceTimer);
  }

  if (autoCommit) {
    session.debounceTimer = setTimeout(() => {
      copyAndCommitSession(session);
    }, debounceSeconds * 1000);
  }

  activeSessions.set(transcriptPath, session);
  updateStatusBar();
}

function updateStatusBar() {
  const active = activeSessions.size;
  statusBarItem.text = `$(comment-discussion) CodingChats (${active})`;
}

async function ensureConversationsRepo(): Promise<string> {
  const { conversationsRepoPath } = getConfig();

  if (!fs.existsSync(conversationsRepoPath)) {
    fs.mkdirSync(conversationsRepoPath, { recursive: true });
    await git(conversationsRepoPath, ["init"]);
    // Create initial structure
    fs.mkdirSync(path.join(conversationsRepoPath, "sessions"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(conversationsRepoPath, "sessions", ".gitkeep"),
      ""
    );
    fs.writeFileSync(
      path.join(conversationsRepoPath, "INDEX.md"),
      "# Coding Conversations Index\n\n| Date | Project | Session | Summary |\n|------|---------|---------|----------|\n"
    );
    await git(conversationsRepoPath, ["add", "."]);
    await git(conversationsRepoPath, [
      "commit",
      "-m",
      "Initial CodingChats conversations repo",
    ]);
    log(`Initialized conversations repo at: ${conversationsRepoPath}`);
  }

  return conversationsRepoPath;
}

async function git(
  cwd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("git", args, { cwd });
  } catch (err: unknown) {
    const error = err as Error & { stdout?: string; stderr?: string };
    log(`git ${args.join(" ")} failed: ${error.message}`);
    throw error;
  }
}

function resolveProjectName(projectHash: string): string {
  // Try to find the project name from the Claude projects directory structure.
  // Claude Code uses the working directory path to create the hash, and often
  // the project config contains the original path.
  const { claudeProjectsPath } = getConfig();
  const projectDir = path.join(claudeProjectsPath, projectHash);

  // Check for a .project.json or similar metadata
  const metaFiles = ["project.json", ".project.json", "config.json"];
  for (const metaFile of metaFiles) {
    const metaPath = path.join(projectDir, metaFile);
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        if (meta.name) return meta.name;
        if (meta.directory) return path.basename(meta.directory);
      } catch {
        // Skip malformed files
      }
    }
  }

  return projectHash;
}

function extractSummary(transcriptPath: string): string {
  try {
    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n");

    // Find the first user message for a summary
    for (const line of lines.slice(0, 20)) {
      try {
        const entry: TranscriptEntry = JSON.parse(line);
        if (entry.role === "user" || entry.type === "human") {
          const text =
            typeof entry.content === "string"
              ? entry.content
              : JSON.stringify(entry.content);
          // Truncate and clean for use as a summary
          const clean = text
            .replace(/[\n\r]+/g, " ")
            .replace(/\|/g, "\\|")
            .trim();
          return clean.length > 120 ? clean.substring(0, 117) + "..." : clean;
        }
      } catch {
        continue;
      }
    }
    return "(no summary)";
  } catch {
    return "(could not read transcript)";
  }
}

async function copyAndCommitSession(session: SessionInfo) {
  try {
    const repoPath = await ensureConversationsRepo();
    const projectName = resolveProjectName(session.projectHash);
    const date = new Date().toISOString().split("T")[0];

    // Create project directory
    const projectDir = path.join(repoPath, "sessions", projectName);
    fs.mkdirSync(projectDir, { recursive: true });

    // Copy transcript
    const destFilename = `${date}-${session.sessionId}.jsonl`;
    const destPath = path.join(projectDir, destFilename);
    fs.copyFileSync(session.transcriptPath, destPath);

    // Update index
    const summary = extractSummary(session.transcriptPath);
    const indexPath = path.join(repoPath, "INDEX.md");
    const indexEntry = `| ${date} | ${projectName} | [${session.sessionId}](sessions/${projectName}/${destFilename}) | ${summary} |\n`;

    const indexContent = fs.readFileSync(indexPath, "utf-8");
    // Insert after header row
    const headerEnd = indexContent.indexOf("|\n", indexContent.lastIndexOf("---")) + 2;
    const updatedIndex =
      indexContent.substring(0, headerEnd) +
      indexEntry +
      indexContent.substring(headerEnd);
    fs.writeFileSync(indexPath, updatedIndex);

    // Git add and commit
    await git(repoPath, ["add", "."]);

    // Check if there are staged changes
    try {
      await git(repoPath, ["diff", "--cached", "--quiet"]);
      log(`No changes to commit for session ${session.sessionId}`);
      return;
    } catch {
      // diff --cached --quiet exits non-zero when there are staged changes
    }

    const commitMsg = `Add conversation: ${projectName} ${date}\n\nSession: ${session.sessionId}\nSummary: ${summary}`;
    await git(repoPath, ["commit", "-m", commitMsg]);
    log(`Committed session ${session.sessionId} for project ${projectName}`);

    const { autoPush } = getConfig();
    if (autoPush) {
      try {
        await git(repoPath, ["push"]);
        log("Pushed to remote");
      } catch {
        log("Push failed — no remote configured or network error");
      }
    }

    statusBarItem.text = `$(check) CodingChats: committed`;
    setTimeout(() => updateStatusBar(), 3000);
  } catch (err: unknown) {
    const error = err as Error;
    log(`Error committing session: ${error.message}`);
    vscode.window.showWarningMessage(
      `CodingChats: Failed to commit conversation — ${error.message}`
    );
  }
}

async function commitNow() {
  log("Manual commit triggered");
  const promises: Promise<void>[] = [];
  for (const session of activeSessions.values()) {
    if (session.debounceTimer) {
      clearTimeout(session.debounceTimer);
      session.debounceTimer = undefined;
    }
    promises.push(copyAndCommitSession(session));
  }
  await Promise.all(promises);
  vscode.window.showInformationMessage(
    `CodingChats: Committed ${promises.length} conversation(s)`
  );
}

async function openLatestConversation() {
  const { conversationsRepoPath } = getConfig();
  const indexPath = path.join(conversationsRepoPath, "INDEX.md");
  if (fs.existsSync(indexPath)) {
    const doc = await vscode.workspace.openTextDocument(indexPath);
    await vscode.window.showTextDocument(doc);
  } else {
    vscode.window.showWarningMessage(
      "CodingChats: No conversations repo found. Conversations will be captured automatically."
    );
  }
}

async function showStatus() {
  const { claudeProjectsPath, conversationsRepoPath, autoCommit, autoPush } =
    getConfig();
  const lines = [
    `Claude projects: ${claudeProjectsPath} (${fs.existsSync(claudeProjectsPath) ? "exists" : "NOT FOUND"})`,
    `Conversations repo: ${conversationsRepoPath} (${fs.existsSync(conversationsRepoPath) ? "exists" : "will be created"})`,
    `Active sessions tracked: ${activeSessions.size}`,
    `Auto-commit: ${autoCommit}`,
    `Auto-push: ${autoPush}`,
  ];
  const message = lines.join("\n");
  log(message);
  vscode.window.showInformationMessage(
    `CodingChats: Tracking ${activeSessions.size} session(s). See Output > CodingChats for details.`
  );
  outputChannel.show();
}
