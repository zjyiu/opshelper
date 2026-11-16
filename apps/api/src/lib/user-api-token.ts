import { createHash, randomBytes } from "node:crypto";

import { prisma } from "./prisma";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

type TokenRecord = { id: string; name: string; createdAt: Date };
type SaveToken = (input: { userId: string; name: string; tokenHash: string }) => Promise<TokenRecord>;
type FindTokenUser = (tokenHash: string) => Promise<{ id: string; isActive: boolean } | null>;

const saveToken: SaveToken = (data) => prisma.userApiToken.create({
  data,
  select: { id: true, name: true, createdAt: true },
});

const findTokenUser: FindTokenUser = async (tokenHash) => {
  const record = await prisma.userApiToken.findUnique({
    where: { tokenHash },
    select: { user: { select: { id: true, isActive: true } } },
  });
  return record?.user ?? null;
};

export async function createUserApiToken(userId: string, name: string, save: SaveToken = saveToken) {
  const token = `ops_${randomBytes(32).toString("hex")}`;
  const record = await save({ userId, name, tokenHash: hashToken(token) });
  return { ...record, token };
}

export async function authenticateUserApiToken(token: string, findUser: FindTokenUser = findTokenUser) {
  if (!/^ops_[a-f0-9]{64}$/.test(token)) return null;
  const user = await findUser(hashToken(token));
  return user?.isActive ? user.id : null;
}
