CREATE TABLE "UserApiToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserApiToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserApiToken_tokenHash_key" ON "UserApiToken"("tokenHash");
CREATE INDEX "UserApiToken_userId_createdAt_idx" ON "UserApiToken"("userId", "createdAt");
ALTER TABLE "UserApiToken" ADD CONSTRAINT "UserApiToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
