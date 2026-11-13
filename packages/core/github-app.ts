import { sign } from "node:crypto";
import { db } from "@devsync/db";
import { githubRepositoryInput, githubRepositoryResponse, githubTokenResponse } from "@devsync/contracts";
import { DomainError, requireProject } from "./index.ts";

export async function linkGithubRepository(userId: string, projectId: string, input: unknown, request = fetch) {
  const { role } = await requireProject(userId, projectId);
  if (role !== "OWNER") throw new DomainError(403, "Only project owners can link a repository.");
  const { installationId, repositoryId } = githubRepositoryInput.parse(input);
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
    repository_ids: [repositoryId], permissions: { metadata: "read" },
  }));
  if (!token.success) throw new DomainError(502, "Invalid GitHub token response.");
  const repository = githubRepositoryResponse.safeParse(await github(`/repositories/${repositoryId}`, token.data.token));
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
