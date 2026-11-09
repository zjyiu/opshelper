UPDATE "User"
SET "name" = 'admin', "updatedAt" = CURRENT_TIMESTAMP
WHERE "email" = 'admin' AND "role" = 'ADMIN' AND "name" = 'Platform Admin';
