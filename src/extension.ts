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

// Cache resolved project names so we don't shell out to git repeatedly
const projectNameCache: Map<string, string> = new Map();

let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let fileWatchers: fs.FSWatcher[] = [];
let activeSessions: Map<string, SessionInfo> = new Map();
let extensionContext: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
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
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codingChats.importExisting",
      importExistingTranscripts
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("codingChats.resetSetup", resetSetup)
  );

  // On first activation, let user choose repo location, then offer import
  const hasSetup = context.globalState.get<boolean>("hasCompletedSetup");
  if (!hasSetup) {
    initialSetup().then(() => startWatching());
  } else {
    startWatching();
  }

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

// --- Project name resolution ---

/**
 * Recover the local filesystem path from a Claude project hash.
 * Claude Code encodes the working directory as: slashes → dashes, with a leading dash.
 * e.g. "-Users-pieper-slicer-latest-SlicerTissue" → "/Users/pieper/slicer/latest/SlicerTissue"
 */
function projectHashToLocalPath(projectHash: string): string {
  // Replace leading dash and convert remaining dashes to slashes
  return "/" + projectHash.replace(/^-/, "").replace(/-/g, "/");
}

/**
 * Parse "owner/repo" from a git remote URL.
 * Handles: git@github.com:owner/repo.git, https://github.com/owner/repo.git, etc.
 */
function parseOwnerRepo(remoteUrl: string): string | null {
  // SSH: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/[:\/]([^/]+)\/([^/]+?)(?:\.git)?\s*$/);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }
  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(
    /\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\s*$/
  );
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }
  return null;
}

/**
 * Resolve a Claude project hash to an "owner/repo" folder name by:
 * 1. Recovering the local path from the hash
 * 2. Running `git remote get-url origin` in that directory
 * 3. Parsing owner/repo from the remote URL
 *
 * Falls back to the last path component if git remote fails (not a git repo,
 * no remote, directory doesn't exist on this machine, etc.)
 */
async function resolveProjectName(projectHash: string): Promise<string> {
  const cached = projectNameCache.get(projectHash);
  if (cached) return cached;

  const localPath = projectHashToLocalPath(projectHash);

  // Try git remote origin
  if (fs.existsSync(localPath)) {
    try {
      const { stdout } = await execFileAsync("git", [
        "-C",
        localPath,
        "remote",
        "get-url",
        "origin",
      ]);
      const ownerRepo = parseOwnerRepo(stdout.trim());
      if (ownerRepo) {
        projectNameCache.set(projectHash, ownerRepo);
        log(`Resolved ${projectHash} → ${ownerRepo}`);
        return ownerRepo;
      }
    } catch {
      // Not a git repo or no remote — fall through
    }
  }

  // Fallback: use the last component of the recovered path
  const fallback = path.basename(localPath);
  projectNameCache.set(projectHash, fallback);
  log(`Resolved ${projectHash} → ${fallback} (fallback, no git remote)`);
  return fallback;
}

// --- File watching ---

function startWatching() {
  const { claudeProjectsPath } = getConfig();

  if (!fs.existsSync(claudeProjectsPath)) {
    log(`Claude projects directory not found: ${claudeProjectsPath}`);
    log("Will retry when directory appears...");
    const parentDir = path.dirname(claudeProjectsPath);
    if (fs.existsSync(parentDir)) {
      const parentWatcher = fs.watch(parentDir, (_event, filename) => {
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

  const projectsWatcher = fs.watch(
    claudeProjectsPath,
    { recursive: true },
    (_event, filename) => {
      if (!filename || !filename.endsWith(".jsonl")) {
        return;
      }
      const fullPath = path.join(claudeProjectsPath, filename);
      handleTranscriptChange(fullPath);
    }
  );
  fileWatchers.push(projectsWatcher);

  scanExistingTranscripts(claudeProjectsPath);
}

function stopWatching() {
  for (const watcher of fileWatchers) {
    watcher.close();
  }
  fileWatchers = [];
}

/**
 * Find the project hash directory for a transcript path.
 * Transcripts can be at:
 *   <projects>/<projectHash>/<session>.jsonl          (main session)
 *   <projects>/<projectHash>/<session>/subagents/*.jsonl (subagents)
 * In both cases we want the projectHash (first directory under projects/).
 */
function getProjectHashFromPath(
  transcriptPath: string,
  projectsDir: string
): string {
  const rel = path.relative(projectsDir, transcriptPath);
  return rel.split(path.sep)[0];
}

function scanExistingTranscripts(projectsDir: string) {
  try {
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectDir = path.join(projectsDir, entry.name);
      collectJsonlFiles(projectDir, entry.name);
    }
    log(`Found ${activeSessions.size} existing transcript(s)`);
  } catch {
    log(`Could not scan projects directory`);
  }
}

function collectJsonlFiles(dir: string, projectHash: string) {
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      if (item.isFile() && item.name.endsWith(".jsonl")) {
        const stat = fs.statSync(fullPath);
        const sessionId = item.name.replace(".jsonl", "");
        activeSessions.set(fullPath, {
          projectHash,
          sessionId,
          transcriptPath: fullPath,
          lastSize: stat.size,
        });
      } else if (item.isDirectory()) {
        // Recurse into session/subagents directories
        collectJsonlFiles(fullPath, projectHash);
      }
    }
  } catch {
    // Skip unreadable dirs
  }
}

function handleTranscriptChange(transcriptPath: string) {
  const { debounceSeconds, autoCommit, claudeProjectsPath } = getConfig();

  if (!fs.existsSync(transcriptPath)) return;

  const stat = fs.statSync(transcriptPath);
  const existing = activeSessions.get(transcriptPath);

  if (existing && stat.size === existing.lastSize) {
    return;
  }

  const projectHash = getProjectHashFromPath(transcriptPath, claudeProjectsPath);
  const sessionId = path.basename(transcriptPath, ".jsonl");

  const session: SessionInfo = {
    projectHash,
    sessionId,
    transcriptPath,
    lastSize: stat.size,
  };

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

// --- Conversations repo management ---

async function ensureConversationsRepo(): Promise<string> {
  const { conversationsRepoPath } = getConfig();

  if (!fs.existsSync(conversationsRepoPath)) {
    fs.mkdirSync(conversationsRepoPath, { recursive: true });
    await git(conversationsRepoPath, ["init"]);
    fs.mkdirSync(path.join(conversationsRepoPath, "sessions"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(conversationsRepoPath, "sessions", ".gitkeep"),
      ""
    );
    fs.writeFileSync(
      path.join(conversationsRepoPath, "INDEX.md"),
      "# Coding Conversations Index\n\n| Date | Machine | Project | Session | Summary |\n|------|---------|---------|---------|----------|\n"
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

/**
 * Pull remote changes with rebase if a remote is configured.
 * This keeps multi-machine repos in sync and avoids push failures.
 */
async function pullIfRemote(repoPath: string) {
  try {
    const { stdout } = await git(repoPath, ["remote"]);
    if (!stdout.trim()) return; // No remote configured
    await git(repoPath, ["pull", "--rebase"]);
    log("Pulled remote changes");
  } catch (err: unknown) {
    const error = err as Error;
    log(`Pull failed (will continue with local commit): ${error.message}`);
  }
}

// --- Transcript helpers ---

function extractDateFromTranscript(transcriptPath: string): string {
  // Use the file's modification time to determine the date
  try {
    const stat = fs.statSync(transcriptPath);
    return stat.mtime.toISOString().split("T")[0];
  } catch {
    return new Date().toISOString().split("T")[0];
  }
}

function extractSummary(transcriptPath: string): string {
  try {
    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n");

    for (const line of lines.slice(0, 20)) {
      try {
        const entry: TranscriptEntry = JSON.parse(line);
        if (entry.role === "user" || entry.type === "human") {
          const text =
            typeof entry.content === "string"
              ? entry.content
              : JSON.stringify(entry.content);
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

/**
 * Determine the relative destination path for a transcript within the conversations repo.
 * Main sessions go to:  sessions/<owner>/<repo>/<date>-<sessionId>.jsonl
 * Subagents go to:       sessions/<owner>/<repo>/subagents/<date>-<agentId>.jsonl
 */
function getDestRelPath(
  session: SessionInfo,
  projectName: string,
  date: string
): { relDir: string; filename: string } {
  const { claudeProjectsPath } = getConfig();
  const transcriptRel = path.relative(
    path.join(claudeProjectsPath, session.projectHash),
    session.transcriptPath
  );
  const parts = transcriptRel.split(path.sep);

  // If path contains "subagents", preserve that structure
  if (parts.includes("subagents")) {
    return {
      relDir: path.join("sessions", projectName, "subagents"),
      filename: `${date}-${session.sessionId}.jsonl`,
    };
  }

  return {
    relDir: path.join("sessions", projectName),
    filename: `${date}-${session.sessionId}.jsonl`,
  };
}

// --- Core commit logic ---

async function copyAndCommitSession(session: SessionInfo) {
  try {
    const repoPath = await ensureConversationsRepo();
    const projectName = await resolveProjectName(session.projectHash);
    const date = extractDateFromTranscript(session.transcriptPath);

    const { relDir, filename } = getDestRelPath(session, projectName, date);
    const destDir = path.join(repoPath, relDir);
    fs.mkdirSync(destDir, { recursive: true });

    const destPath = path.join(destDir, filename);
    fs.copyFileSync(session.transcriptPath, destPath);

    // Update index (only for main sessions, not subagents)
    if (!relDir.includes("subagents")) {
      const summary = extractSummary(session.transcriptPath);
      const machine = os.hostname();
      const indexPath = path.join(repoPath, "INDEX.md");
      const indexEntry = `| ${date} | ${machine} | ${projectName} | [${session.sessionId}](${relDir}/${filename}) | ${summary} |\n`;

      const indexContent = fs.readFileSync(indexPath, "utf-8");
      // Don't add duplicate entries; append at end for clean multi-machine merges
      if (!indexContent.includes(session.sessionId)) {
        const updatedIndex = indexContent.trimEnd() + "\n" + indexEntry;
        fs.writeFileSync(indexPath, updatedIndex);
      }
    }

    // Pull remote changes before committing to avoid conflicts across machines
    await pullIfRemote(repoPath);

    await git(repoPath, ["add", "."]);

    // Check if there are staged changes
    try {
      await git(repoPath, ["diff", "--cached", "--quiet"]);
      log(`No changes to commit for session ${session.sessionId}`);
      return;
    } catch {
      // Has staged changes — continue
    }

    const summary = extractSummary(session.transcriptPath);
    const machine = os.hostname();
    const commitMsg = `Add conversation: ${projectName} ${date}\n\nSession: ${session.sessionId}\nMachine: ${machine}\nSummary: ${summary}`;
    await git(repoPath, ["commit", "-m", commitMsg]);
    log(`Committed session ${session.sessionId} for project ${projectName}`);

    const { autoPush } = getConfig();
    if (autoPush) {
      try {
        await git(repoPath, ["push"]);
        log("Pushed to remote");
      } catch (err: unknown) {
        const error = err as Error;
        log(`Push failed: ${error.message}`);
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

// --- Import existing transcripts ---

interface ImportCandidate {
  projectHash: string;
  projectName: string;
  sessions: SessionInfo[];
  totalSize: number;
}

async function gatherImportCandidates(): Promise<ImportCandidate[]> {
  const { claudeProjectsPath, conversationsRepoPath } = getConfig();
  if (!fs.existsSync(claudeProjectsPath)) return [];

  // Figure out what's already been imported
  const alreadyImported = new Set<string>();
  const sessionsDir = path.join(conversationsRepoPath, "sessions");
  if (fs.existsSync(sessionsDir)) {
    collectImportedSessionIds(sessionsDir, alreadyImported);
  }

  const candidates: Map<string, ImportCandidate> = new Map();
  const entries = fs.readdirSync(claudeProjectsPath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectHash = entry.name;
    const projectName = await resolveProjectName(projectHash);
    const projectDir = path.join(claudeProjectsPath, projectHash);

    const sessions: SessionInfo[] = [];
    let totalSize = 0;
    collectAllTranscripts(projectDir, projectHash, sessions, alreadyImported);
    for (const s of sessions) {
      totalSize += s.lastSize;
    }

    if (sessions.length > 0) {
      candidates.set(projectHash, {
        projectHash,
        projectName,
        sessions,
        totalSize,
      });
    }
  }

  return Array.from(candidates.values());
}

function collectImportedSessionIds(dir: string, set: Set<string>) {
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.isFile() && item.name.endsWith(".jsonl")) {
        // Filename format: <date>-<sessionId>.jsonl — extract sessionId
        const match = item.name.match(/^\d{4}-\d{2}-\d{2}-(.+)\.jsonl$/);
        if (match) set.add(match[1]);
      } else if (item.isDirectory()) {
        collectImportedSessionIds(path.join(dir, item.name), set);
      }
    }
  } catch {
    // skip
  }
}

function collectAllTranscripts(
  dir: string,
  projectHash: string,
  results: SessionInfo[],
  alreadyImported: Set<string>
) {
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      if (item.isFile() && item.name.endsWith(".jsonl")) {
        const sessionId = item.name.replace(".jsonl", "");
        if (alreadyImported.has(sessionId)) continue;
        const stat = fs.statSync(fullPath);
        if (stat.size < 100) continue; // Skip tiny/empty transcripts
        results.push({
          projectHash,
          sessionId,
          transcriptPath: fullPath,
          lastSize: stat.size,
        });
      } else if (item.isDirectory()) {
        collectAllTranscripts(fullPath, projectHash, results, alreadyImported);
      }
    }
  } catch {
    // skip
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Check if the user has a CodingChats-conversations repo on GitHub.
 * Uses `gh repo list` to search. Returns "owner/repo" if found, null otherwise.
 */
async function findGitHubConversationsRepo(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("gh", [
      "repo",
      "list",
      "--json",
      "nameWithOwner",
      "--jq",
      '.[].nameWithOwner',
      "--limit",
      "200",
    ]);
    const repos = stdout.trim().split("\n");
    const match = repos.find((r) =>
      r.toLowerCase().endsWith("/codingchats-conversations")
    );
    if (match) {
      log(`Found existing GitHub repo: ${match}`);
      return match;
    }
  } catch (err: unknown) {
    const error = err as Error;
    log(`gh repo list failed (gh CLI may not be installed): ${error.message}`);
  }
  return null;
}

async function initialSetup() {
  const defaultPath = path.join(os.homedir(), "CodingChats-conversations");
  const config = vscode.workspace.getConfiguration("codingChats");

  // If the user already configured a path in settings, skip the location prompt
  const configuredPath = config.get<string>("conversationsRepoPath");
  if (!configuredPath) {
    // Check if the user already has a CodingChats-conversations repo on GitHub
    const ghRepo = await findGitHubConversationsRepo();

    if (ghRepo) {
      const cloneChoice = await vscode.window.showInformationMessage(
        `Found existing repo on GitHub: ${ghRepo}. Clone it?`,
        "Clone to Default Location",
        "Clone to Custom Location",
        "Skip (Start Fresh)"
      );

      if (
        cloneChoice === "Clone to Default Location" ||
        cloneChoice === "Clone to Custom Location"
      ) {
        let clonePath = defaultPath;
        if (cloneChoice === "Clone to Custom Location") {
          const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: "Select folder to clone into",
            title:
              "Choose parent directory for the CodingChats conversations repo",
          });
          if (picked && picked.length > 0) {
            clonePath = path.join(picked[0].fsPath, "CodingChats-conversations");
          }
        }

        if (!fs.existsSync(clonePath)) {
          try {
            await execFileAsync("gh", [
              "repo",
              "clone",
              ghRepo,
              clonePath,
            ]);
            log(`Cloned ${ghRepo} to ${clonePath}`);
          } catch (err: unknown) {
            const error = err as Error;
            log(`Failed to clone ${ghRepo}: ${error.message}`);
            vscode.window.showWarningMessage(
              `CodingChats: Could not clone ${ghRepo} — ${error.message}`
            );
          }
        } else {
          log(
            `Clone target already exists: ${clonePath}, using it as-is`
          );
        }

        if (clonePath !== defaultPath) {
          await config.update(
            "conversationsRepoPath",
            clonePath,
            vscode.ConfigurationTarget.Global
          );
        }
      }
      // "Skip" falls through to normal setup
    } else {
      // No GitHub repo found — offer standard location choices
      const locationChoice = await vscode.window.showInformationMessage(
        `CodingChats will store conversations in: ${defaultPath}`,
        "Use Default",
        "Choose Location",
        "Select Existing Repo"
      );

      if (locationChoice === "Choose Location") {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: "Select folder for conversations repo",
          title: "Choose where to create the CodingChats conversations repo",
        });
        if (picked && picked.length > 0) {
          const chosenPath = picked[0].fsPath;
          await config.update(
            "conversationsRepoPath",
            chosenPath,
            vscode.ConfigurationTarget.Global
          );
          log(`Conversations repo path set to: ${chosenPath}`);
        }
      } else if (locationChoice === "Select Existing Repo") {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: "Select existing conversations repo",
          title: "Select an existing CodingChats conversations repo",
        });
        if (picked && picked.length > 0) {
          const chosenPath = picked[0].fsPath;
          await config.update(
            "conversationsRepoPath",
            chosenPath,
            vscode.ConfigurationTarget.Global
          );
          log(`Conversations repo path set to existing repo: ${chosenPath}`);
        }
      }
      // "Use Default" or dismissed — leave the setting empty so getConfig() uses the default
    }
  }

  extensionContext.globalState.update("hasCompletedSetup", true);

  // Now offer to import existing transcripts
  const { claudeProjectsPath } = getConfig();
  if (!fs.existsSync(claudeProjectsPath)) return;

  let hasTranscripts = false;
  try {
    const entries = fs.readdirSync(claudeProjectsPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const files = fs.readdirSync(path.join(claudeProjectsPath, entry.name));
      if (files.some((f) => f.endsWith(".jsonl"))) {
        hasTranscripts = true;
        break;
      }
    }
  } catch {
    // skip
  }

  if (!hasTranscripts) return;

  const importChoice = await vscode.window.showInformationMessage(
    "CodingChats found existing Claude Code conversations. Import them?",
    "Import All",
    "Choose Projects",
    "Skip"
  );

  if (importChoice === "Import All") {
    await importExistingTranscripts();
  } else if (importChoice === "Choose Projects") {
    await importSelectiveTranscripts();
  }
}

async function resetSetup() {
  extensionContext.globalState.update("hasCompletedSetup", false);
  stopWatching();
  await initialSetup();
  startWatching();
  vscode.window.showInformationMessage(
    `CodingChats: Now using ${getConfig().conversationsRepoPath}`
  );
}

async function importExistingTranscripts() {
  const candidates = await gatherImportCandidates();
  if (candidates.length === 0) {
    vscode.window.showInformationMessage(
      "CodingChats: No new conversations to import."
    );
    return;
  }

  const totalSessions = candidates.reduce(
    (n, c) => n + c.sessions.length,
    0
  );
  const totalSize = candidates.reduce((n, c) => n + c.totalSize, 0);

  const confirm = await vscode.window.showInformationMessage(
    `Import ${totalSessions} conversation(s) from ${candidates.length} project(s) (${formatSize(totalSize)})?`,
    "Import",
    "Cancel"
  );
  if (confirm !== "Import") return;

  await doImport(candidates);
}

async function importSelectiveTranscripts() {
  const candidates = await gatherImportCandidates();
  if (candidates.length === 0) {
    vscode.window.showInformationMessage(
      "CodingChats: No new conversations to import."
    );
    return;
  }

  const picks = candidates.map((c) => ({
    label: c.projectName,
    description: `${c.sessions.length} session(s), ${formatSize(c.totalSize)}`,
    picked: true,
    candidate: c,
  }));

  const selected = await vscode.window.showQuickPick(picks, {
    canPickMany: true,
    placeHolder: "Select projects to import conversations from",
  });

  if (!selected || selected.length === 0) return;

  await doImport(selected.map((s) => s.candidate));
}

async function doImport(candidates: ImportCandidate[]) {
  const totalSessions = candidates.reduce(
    (n, c) => n + c.sessions.length,
    0
  );

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "CodingChats: Importing conversations",
      cancellable: true,
    },
    async (progress, token) => {
      let imported = 0;
      for (const candidate of candidates) {
        if (token.isCancellationRequested) break;
        for (const session of candidate.sessions) {
          if (token.isCancellationRequested) break;
          progress.report({
            message: `${candidate.projectName} (${imported + 1}/${totalSessions})`,
            increment: (1 / totalSessions) * 100,
          });
          await copyAndCommitSession(session);
          imported++;
        }
      }

      vscode.window.showInformationMessage(
        `CodingChats: Imported ${imported} conversation(s) from ${candidates.length} project(s).`
      );
    }
  );
}

// --- Commands ---

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
