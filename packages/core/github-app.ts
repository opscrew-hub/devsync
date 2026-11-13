import { sign } from "node:crypto";
import { db } from "@devsync/db";
import { githubCommitResponse, githubSnapshot, githubSnapshotMetadata, githubSnapshotChecks, githubRepositoryInput, githubRepositoryResponse, githubTokenResponse } from "@devsync/contracts";
import { DomainError, requireProject } from "./index.ts";

export async function linkGithubRepository(userId: string, projectId: string, input: unknown, request = fetch) {
  const { role } = await requireProject(userId, projectId);
  if (role !== "OWNER") throw new DomainError(403, "Only project owners can link a repository.");
  const { installationId, repositoryId } = githubRepositoryInput.parse(input);
  const { github, token } = await installationClient(projectId, installationId, repositoryId, { metadata: "read" }, request);
  const repository = githubRepositoryResponse.safeParse(await github(`/repositories/${repositoryId}`, token));
  if (!repository.success || repository.data.id !== repositoryId) throw new DomainError(502, "GitHub returned a different repository.");
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
    const data = { installationId: BigInt(installationId), repositoryId: BigInt(repositoryId), fullName: repository.data.full_name, verifiedAt: new Date() };
    const saved = await tx.githubRepository.upsert({ where: { projectId }, create: { projectId, ...data }, update: data });
    await tx.auditLog.create({ data: {
      projectId, actorId: userId, action: "github.repository_linked", targetId: String(repositoryId), details: { name: saved.fullName },
    } });
    return serialize(saved);
  }).catch(error => {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      throw new DomainError(409, "Repository is already linked to another project.");
    }
    throw error;
  });
}

function serialize<T extends { installationId: bigint; repositoryId: bigint }>(row: T) {
  return { ...row, installationId: String(row.installationId), repositoryId: String(row.repositoryId) };
}

export async function getGithubRepository(userId: string, projectId: string) {
  await requireProject(userId, projectId);
  const row = await db.githubRepository.findUnique({ where: { projectId } });
  return row ? serialize(row) : null;
}

async function installationClient(projectId: string, installationId: number, repositoryId: number, permissions: object, request: typeof fetch) {
  const appId = process.env.GITHUB_APP_ID;
  const key = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !key) throw new DomainError(503, "GitHub App is not configured.");
  const allowed = (process.env.GITHUB_PROJECT_REPOSITORIES ?? "").split(",").map(pair => pair.trim());
  if (!allowed.includes(`${projectId}:${installationId}:${repositoryId}`)) {
    throw new DomainError(403, "Repository is not authorized for this project.");
  }
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: appId, iat: now - 60, exp: now + 480 })}`;
  const jwt = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key.replaceAll("\\n", "\n")).toString("base64url")}`;
  async function github(path: string, bearer: string, body?: object) {
    const response = await request("https://api.github.com" + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${bearer}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error", signal: AbortSignal.timeout(10000),
    }).catch(() => { throw new DomainError(502, "GitHub could not be reached."); });
    if (!response.ok) throw new DomainError(502, "GitHub could not verify repository access.");
    return response.json().catch(() => { throw new DomainError(502, "Invalid GitHub response."); });
  }
  const token = githubTokenResponse.safeParse(await github(`/app/installations/${installationId}/access_tokens`, jwt, {
    repository_ids: [repositoryId], permissions,
  }));
  if (!token.success) throw new DomainError(502, "Invalid GitHub token response.");
  return { github, token: token.data.token };
}

export async function refreshGithubSnapshot(userId: string, projectId: string, request = fetch) {
  const { role } = await requireProject(userId, projectId);
  if (role !== "OWNER" && role !== "ADMIN") throw new DomainError(403, "Project administrator access required.");
  const repo = await db.githubRepository.findUnique({ where: { projectId } });
  if (!repo) throw new DomainError(404, "Link a repository first.");
  const { github, token } = await installationClient(projectId, Number(repo.installationId), Number(repo.repositoryId),
    { metadata: "read", contents: "read", pull_requests: "read", checks: "read" }, request);
  const metadata = githubSnapshotMetadata
    .safeParse(await github("/repositories/" + repo.repositoryId, token));
  if (!metadata.success || BigInt(metadata.data.id) !== repo.repositoryId) throw new DomainError(502, "Invalid GitHub repository response.");
  const path = "/repos/" + metadata.data.full_name;
  const [branchRows, pullRows, checkRows] = await Promise.all([
    github(path + "/branches?per_page=30", token),
    github(path + "/pulls?state=all&sort=updated&direction=desc&per_page=30", token),
    github(path + "/commits/" + encodeURIComponent(metadata.data.default_branch) + "/check-runs?per_page=30", token),
  ]);
  const snapshot = githubSnapshot.safeParse({
    fetchedAt: new Date().toISOString(), branches: branchRows, pulls: pullRows,
    checks: githubSnapshotChecks.safeParse(checkRows).data?.check_runs,
  });
  if (!snapshot.success) throw new DomainError(502, "Invalid GitHub snapshot response.");
  const saved = await db.githubRepository.updateMany({
    where: { projectId, repositoryId: repo.repositoryId, installationId: repo.installationId, verifiedAt: repo.verifiedAt },
    data: { snapshot: snapshot.data },
  });
  if (!saved.count) throw new DomainError(409, "Repository changed during refresh.");
  return snapshot.data;
}

export async function resolveGithubRunSource(
  run: { projectId: string; installationId: string; repositoryId: string },
  signal: AbortSignal,
  request = fetch,
) {
  signal.throwIfAborted();
  const { installationId, repositoryId } = githubRepositoryInput.parse({
    installationId: Number(run.installationId), repositoryId: Number(run.repositoryId),
  });
  const abortable: typeof fetch = (url, options) => request(url, {
    ...options, signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
  });
  const { github, token } = await installationClient(
    run.projectId, installationId, repositoryId, { metadata: "read", contents: "read" }, abortable,
  );
  const metadata = githubSnapshotMetadata.safeParse(await github(`/repositories/${repositoryId}`, token));
  if (!metadata.success || metadata.data.id !== repositoryId) {
    throw new DomainError(502, "Invalid GitHub repository response.");
  }
  const { full_name, default_branch } = metadata.data;
  const commit = githubCommitResponse.safeParse(await github(
    `/repos/${full_name}/commits/${encodeURIComponent(default_branch)}`, token,
  ));
  if (!commit.success) throw new DomainError(502, "Invalid GitHub commit response.");
  signal.throwIfAborted();
  return { repository: `https://github.com/${full_name}.git`, commit: commit.data.sha };
}
