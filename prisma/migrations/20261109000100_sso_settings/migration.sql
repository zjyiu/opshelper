CREATE TABLE "SsoSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "encryptedSecret" TEXT,
    "accountWhitelist" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SsoSettings_pkey" PRIMARY KEY ("id")
);
