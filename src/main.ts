import * as core from "@actions/core";
import * as github from "@actions/github";
import * as tc from "@actions/tool-cache";
import { exec } from "@actions/exec";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const ACTION_URL = "https://github.com/ehshit/winget-action";

function walkYamlFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkYamlFiles(full));
    } else if (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) {
      results.push(full);
    }
  }
  return results;
}

async function run(): Promise<void> {
  const packageId = core.getInput("package-id", { required: true });
  const assetPattern = core.getInput("asset-pattern", { required: true });
  const forkOwner = core.getInput("fork-owner", { required: true });
  const token = core.getInput("token", { required: true });
  const versionOverride = core.getInput("version");
  const repoInput = core.getInput("repository");
  const komacVersion = core.getInput("komac-version") || "2.13.0";
  const actionVersion = process.env.GITHUB_ACTION_REF || "unknown";

  core.setSecret(token);
  const octokit = github.getOctokit(token);
  const { owner: ctxOwner, repo: ctxRepo } = github.context.repo;
  const fullRepo = repoInput || `${ctxOwner}/${ctxRepo}`;
  const [repoOwner, repoName] = fullRepo.split("/");

  let tag =
    versionOverride ||
    (github.context.payload.release as { tag_name?: string } | undefined)
      ?.tag_name;
  if (!tag) {
    const { data } = await octokit.rest.repos.getLatestRelease({
      owner: repoOwner,
      repo: repoName,
    });
    tag = data.tag_name;
  }
  const version = tag.replace(/^v/, "");
  core.setOutput("version", version);
  core.info(`Resolved version: ${version} (tag ${tag})`);

  core.info(`Installing komac v${komacVersion}`);
  const komacUrl = `https://github.com/russellbanks/Komac/releases/download/v${komacVersion}/komac-${komacVersion}-x86_64-unknown-linux-gnu.tar.gz`;
  const komacArchive = await tc.downloadTool(komacUrl);
  const komacDir = await tc.extractTar(komacArchive);
  const komacBin = path.join(komacDir, "komac");
  fs.chmodSync(komacBin, 0o755);

  const { data: release } = await octokit.rest.repos.getReleaseByTag({
    owner: repoOwner,
    repo: repoName,
    tag,
  });
  const regex = new RegExp(assetPattern);
  const asset = release.assets.find((a) => regex.test(a.name));
  if (!asset) {
    const names = release.assets.map((a) => a.name).join(", ") || "(none)";
    throw new Error(
      `No release asset matching /${assetPattern}/. Available: ${names}`
    );
  }
  const downloadUrl = `https://github.com/${fullRepo}/releases/download/${tag}/${encodeURIComponent(asset.name)}`;
  core.info(`Asset: ${asset.name}`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "winget-"));
  const manifestDir = path.join(workDir, "manifests");

  core.info(`Generating manifests with komac (no submit)`);
  let komacOutput = "";
  const exitCode = await exec(
    komacBin,
    [
      "update",
      packageId,
      "--urls",
      downloadUrl,
      "--version",
      version,
      "--output",
      manifestDir,
    ],
    {
      ignoreReturnCode: true,
      env: {
        ...process.env,
        GITHUB_TOKEN: token,
      },
      listeners: {
        stdout: (data: Buffer) => {
          komacOutput += data.toString();
        },
        stderr: (data: Buffer) => {
          komacOutput += data.toString();
        },
      },
    }
  );
  core.info(komacOutput);
  if (exitCode !== 0) {
    throw new Error(`komac failed with exit code ${exitCode}`);
  }

  const yamlFiles = walkYamlFiles(manifestDir);
  if (yamlFiles.length === 0) {
    throw new Error(`komac produced no yaml files in ${manifestDir}`);
  }
  core.info(`Generated ${yamlFiles.length} manifest file(s)`);

  core.info(`Cloning winget-pkgs and preparing branch`);
  const cloneDir = path.join(workDir, "winget-pkgs");
  await exec("git", [
    "clone",
    "--depth",
    "1",
    "--branch",
    "master",
    "https://github.com/microsoft/winget-pkgs.git",
    cloneDir,
  ]);

  const branchName = `winget-${packageId}-${version}`;
  await exec("git", ["checkout", "-b", branchName], { cwd: cloneDir });

  function copyDir(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
  copyDir(manifestDir, cloneDir);

  await exec("git", ["add", "-A"], { cwd: cloneDir });
  await exec(
    "git",
    ["commit", "-m", `Update ${packageId} to ${version}`],
    { cwd: cloneDir }
  );
  await exec("git", ["push", "origin", branchName], {
    cwd: cloneDir,
    env: {
      ...process.env,
      GITHUB_TOKEN: token,
    },
  });

  const workflowUrl = `${github.context.serverUrl}/${ctxOwner}/${ctxRepo}/actions/runs/${github.context.runId}`;
  const releaseUrl = `${github.context.serverUrl}/${fullRepo}/releases/tag/${tag}`;
  const body = [
    `# Automated with [winget-action](${ACTION_URL}) v${actionVersion} with komac ${komacVersion}`,
    ``,
    `Ran from this [Workflow](${workflowUrl}) via the [new release](${releaseUrl})`,
  ].join("\n");

  core.info(`Creating PR from ${forkOwner}:${branchName}`);
  const { data: pr } = await octokit.rest.pulls.create({
    owner: "microsoft",
    repo: "winget-pkgs",
    head: `${forkOwner}:${branchName}`,
    base: "master",
    title: `New Ver: ${packageId} version ${version}`,
    body,
  });
  core.setOutput("pr", pr.number);
  core.info(`Opened PR #${pr.number}: ${pr.html_url}`);
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
